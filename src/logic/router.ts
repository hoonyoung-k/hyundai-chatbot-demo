// src/logic/router.ts

import { parseIntent } from "./intent";
import { moderateInput, sanitizeOutput, COPY, cushionMsgs, withCushion } from "./safety";
import { logEvent } from "./logger";
import { recGood, recBad, recTotal } from "./metrics";
import { guardOutput } from "./safety-guard";
import { callLLM } from "./bridge";
import { loadOverrides, keyQ } from './overrides';

import vehicles from "../assets/vehicles.json";
import centers from "../assets/centers.json";
import faqEmbed from "../assets/faq.json";



// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------
export type Faq = { id: string; q: string; a: string; url?: string };

export type Chip = string;
export type VehicleCard = {
  type: "vehicle";
  id: string;
  title: string;
  spec?: { range_km?: number; segment?: string };
  price_from?: number;
  badges?: string[];
  cta?: { label: string; action: string; id: string }[];
};
export type CenterCard = {
  type: "center";
  id: string;
  title: string;
  kind: string;
  distance_km: number;
  ev_ok: boolean;
  cta?: { label: string; action: string; id: string }[];
};
export type EvRecommendCard = { type: "ev_recommend" };
export type HomeCard = { type: "home" };

export type BotReply = {
  messages: string[];
  chips?: Chip[];
  cards?: (VehicleCard | CenterCard | EvRecommendCard | HomeCard)[];
  sticky_cta?: { label: string; action: string; id?: string } | null;
};

// ⬇️ 추가: 회귀/콘솔용 메타 타입
type Meta = {
  path: "RAG" | "OpenDomain" | "Fallback";
  model?: string;
  rewriteApplied?: boolean;
  topScore?: number;
  retrievedIds?: string[];
  primaryUrl?: string | null;
  tokens?: string; // "in/out" 등 요약
};

// (기존 상수 유지: 필요 시 사용할 수 있으므로 보존)
const TAU_STRONG = 0.62;
const TAU_WEAK = 0.35;


// Open-domain fallback 스위치/임계값 (.env)
const ENV = (import.meta as any)?.env ?? {};
export const ALLOW_OPEN_DOMAIN = String(ENV.VITE_ALLOW_OPEN_DOMAIN ?? "")
  .trim()
  .toLowerCase()
  .startsWith("true");

export const OOD_THRESHOLD = Number(
  String(ENV.VITE_OOD_THRESHOLD ?? "0.12").split(/[\s#]/)[0] || "0.12"
);

let _faq: Faq[] | null = null;

async function getFaq(): Promise<Faq[]> {
  if (_faq) return _faq;
  try {
    const res = await fetch("/faq.json", { cache: "no-store" });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data) && data.length) {
        _faq = data as Faq[];
        return _faq!;
      }
      console.warn("[RAG] /faq.json empty or invalid; using embedded");
    } else {
      console.warn("[RAG] /faq.json http", res.status, "— using embedded");
    }
  } catch (e) {
    console.warn("[RAG] fetch /faq.json failed; using embedded", e);
  }
  _faq = (faqEmbed as unknown) as Faq[];
  return _faq!;
}



function norm(s?: string){
  return (s??'')
    .toLowerCase()
    .replace(/\s+/g,' ')                   // 다중 공백 정리
    .replace(/([가-힣a-z])\s+([0-9]+)/gi,'$1$2') // ✅ 한글/영문+숫자 붙이기: 아이오닉 5 → 아이오닉5, ev 6 → ev6
    .trim();
}


// === [NEW] A/B/C 변형을 대표 id(캐논)로 묶기 위한 전역 가드 ===
const baseIdOf = (id: string) => id.replace(/-(b|c)$/i, "");

type FaqItem = { id: string; q: string; a: string; url?: string; category?: string };
let GROUPS: Record<string, { base: string; questions: string[] }> = {};
let __groupsBuilt = false;

async function ensureGroupsBuilt() {
  if (__groupsBuilt && Object.keys(GROUPS).length) return;
  const faqs = await getFaq();
  GROUPS = {};
  for (const f of faqs as FaqItem[]) {
    const base = f.id.replace(/-(b|c)$/i, "");
    if (!GROUPS[base]) GROUPS[base] = { base, questions: [] };
    GROUPS[base].questions.push(f.q);
  }
  __groupsBuilt = true;
}


function tokensKO(s: string) {
  const t = norm(s);
  const words = t.split(" ").filter(Boolean);
  const grams: string[] = [];
  for (const w of words) {
    if (w.length >= 2) for (let i = 0; i < w.length - 1; i++) grams.push(w.slice(i, i + 2));
  }
  return new Set([...words, ...grams]);
}

function jaccard(a: Set<string>, b: Set<string>) {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const uni = a.size + b.size - inter;
  return uni ? inter / uni : 0;
}

// 질의를 A/B/C 묶음(그룹)과 비교하여 가장 유사한 대표 id 반환
async function guardRouteByGroups(query: string): Promise<{ id: string; reason: string } | null> {
  await ensureGroupsBuilt();
  if (!Object.keys(GROUPS).length) return null;

  const qt = tokensKO(query);
  const isShort = norm(query).length <= 10 || norm(query).split(" ").length <= 3;

  let best: { base: string; sim: number } | null = null;
  for (const g of Object.values(GROUPS)) {
    const gt = tokensKO(g.questions.join(" "));
    let sim = jaccard(qt, gt);
    if (isShort) sim += 0.12; // 초단문 가산
    if (!best || sim > best.sim) best = { base: g.base, sim };
  }
  if (best && best.sim >= 0.28) {
    return { id: best.base, reason: `group-guard@${best.sim.toFixed(2)}` };
  }
  return null;
}

// 대표 id로 즉시 응답 구성 (Gold처럼 강제 라우팅)
async function answerWithFaqId(faqId: string, meta: Record<string, any> = {}): Promise<BotReply | null> {
  const faqs = await getFaq();
  const hit = (faqs as FaqItem[]).find(f => f.id === faqId);
  if (!hit) return null;
  const msg = guardOutput(hit.a);
  const noCta = Boolean(meta?.noCta) || /^faq-kb-/i.test(String(hit.id || ""));
  const reply: BotReply = {
    messages: [msg],
    chips: ["자주 묻는 질문", "처음으로"],
    cards: [],
    sticky_cta: noCta ? null : buildSingleCTA(hit.url ?? null),
  };
  (reply as any).__meta = { path: "RAG", ...meta, primaryUrl: hit.url ?? null };
  return reply;
}


// 거리 계산 (km)
function haversine(lat1:number, lon1:number, lat2:number, lon2:number) {
  const R = 6371; const toRad = (d:number)=>d*Math.PI/180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// "lat:37.5 lng:127.0" 형태 파싱
function pickCoords(utter:string) {
  const m = utter.match(/lat\s*:\s*([0-9.]+)\s*[, ]\s*lng\s*:\s*([0-9.]+)/i);
  if (!m) return null;
  return { lat: parseFloat(m[1]), lng: parseFloat(m[2]) };
}




// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------
function needsDisclaimerFor(text: string): boolean {
  return /가격|프로모션|혜택|보조금|보증|리콜/.test(text);
}

function isOOD(text: string): boolean {
  return /(날씨|기상|미세먼지|우산|기온|주식|코스피|코스닥|주가|배당|연예|아이돌|BTS|음악|영화|드라마)/i.test(text);
}

function isWeakEvInfo(text: string): boolean {
  const strong = /(추천|비교|TOP|순위|사양|스펙)/i;
  if (strong.test(text)) return false;
  return /(EV|전기차|충전|보조금|유지비)/i.test(text) && !/추천/i.test(text);
}

function isWeakCenter(text: string): boolean {
  const strong = /(가까운|근처|주소|길찾기|지도|예약|전화)/i;
  if (strong.test(text)) return false;
  return /(센터|서비스|정비|예약|점검)/i.test(text);
}

// LLM 답변 안의 디버그/출처/링크 문구 정리
function cleanText(t: string) {
  return t
    .replace(/^문서\d+:\s*/gm, "")
    .replace(/\[[^\]]*출처[^\]]*\]/g, "")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, "$1 ($2)") // MD 링크 평문화
    .replace(/공식\s*안내\s*보기\s*버튼(?:을)?(?:\s*이용)?(?:해\s*주세요|을\s*눌러\s*주세요|을\s*통해\s*확인해\s*주세요)?\.?/gi, "")
    .replace(/자세히\s*보기\.?/gi, "")
    .replace(/공식\s*안내(?:를)?\s*확인해\s*주세요\.?/gi, "")
    .replace(/버튼(?:을)?\s*통해\s*확인(?:해\s*주세요)?\.?/gi, "")
    .trim();
}

const CORE_ENTITY_CANON = [
  "아반떼", "아반떼 N", "쏘나타", "그랜저", "싼타페", "투싼", "팰리세이드",
  "코나", "캐스퍼", "스타리아", "포터", "아이오닉 5", "아이오닉 6", "아이오닉 9",
  "G70", "G80", "G90", "GV60", "GV70", "GV80", "정주영", "정몽구", "정의선",
];

function isCoreEntityQuery(text: string): boolean {
  const q = rewriteQuery(text || "").toLowerCase();
  return CORE_ENTITY_CANON.some((canon) => q.includes(canon.toLowerCase()));
}

// 사과 톤 감지(FAQ 밖/오픈도메인 가이드 문구)
const APOLOGY_REGEX =
  /(FAQ\s*범위\s*밖\s*질문입니다\.?|죄송합니다\.\s*현대자동차\s*관련\s*내용만\s*답변\s*가능)/;

// 현대 공식 도메인만 CTA 허용
// ✅ 상위 1개(retr[0])의 URL만 사용 → 해당 FAQ의 url이 비어 있으면 CTA 숨김
function pickPrimaryUrl(retr: Array<{ url?: string }>): string | null {
  const allow = /^(https?:\/\/)?(www\.)?hyundai(\.com|\.co\.kr)/i;
  const top = retr?.[0];
  const url = (top?.url || "").trim();
  return allow.test(url) ? url : null;
}


// 단일 CTA 생성 (URL 없으면 null)
function buildSingleCTA(url: string | null): { label: string; action: "url:open"; id: string } | null {
  const u = (url ?? "").trim();
  // http(s)/tel/mailto가 아니면 버튼 생성하지 않음
  if (!u || !/^(https?:\/\/|tel:|mailto:)/i.test(u)) return null;
  return { label: "자세히 보기", action: "url:open", id: u };
}


// === Step 3: Fallback 표준 문구/CTA 유틸 ===
const SUPPORT_PHONE = "080-600-6000";

// 고객센터 CTA (tel)
function buildSupportCTA() {
  return {
    label: "고객센터 연결",
    action: "url:open" as const,
    id: "https://www.hyundai.com/kr/ko/e/customer/center",  // ✅ 변경 URL
  };
}


// 표준 Fallback 본문
function fallbackMessage() {
  return "제공된 정보만으로는 정확히 확인이 어렵습니다.";
}

// 표준 Fallback 응답 생성기
function makeFallbackReply(msgExtras: string[] = [], chips: string[] = []): BotReply {
  return {
    messages: cushionMsgs([fallbackMessage(), ...msgExtras].join("\n"), { disclaimer: false }),
    chips,
    cards: [],
    // Step 3: Fallback에는 고객센터 CTA를 항상 노출 (tel 링크는 허용)
    sticky_cta: buildSupportCTA(),
  };
}

// 하이리스크(정책/결제/개인정보/제재/확률 등) 감지
function isHighRisk(text: string): boolean {
  return /(정책|개인정보|수집|보관|파기|유출|제재|징계|벌점|처벌|페널티|확률|당첨|보상|배상|보험)/i.test(text);
}



// -----------------------------------------------------------------------------
// RAG: BM25 Retriever
// -----------------------------------------------------------------------------
type Doc = {
  id: string;
  text: string; // q + a 결합
  url?: string;
  toks: string[];
  tf: Record<string, number>;
  len: number;
};

const K1 = 1.5;
const B = 0.75;
const MIN_SCORE = 0.05; // 너무 낮으면 잡음↑

// 한글/영문/숫자만 남기고 공백 분리
function tok(s: string) {
  return (s || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

let DOCS: Doc[] = [];
let IDF = new Map<string, number>();
let AVG_LEN = 1;

// --- RAG alias variants (canonical -> variants added to doc text at index time) ---
const VARIANTS_CANON: Record<string, string[]> = {
  '아반떼': ['아반테', 'avante', '엘란트라', 'elantra'],
  '아반떼 N': ['아반떼n', '아반테n', 'avante n', 'avante-n'],
  '쏘나타': ['소나타', 'sonata'],
  '그랜저': ['그랜져', 'grandeur'],
  '싼타페': ['산타페', 'santafe', 'santa fe'],
  '투싼': ['투산', 'tucson'],
  '팰리세이드': ['펠리세이드', 'palisade'],
  '코나': ['kona'],
  '캐스퍼': ['casper'],
  '스타리아': ['staria'],
  '포터': ['포터2', '포터 ii', 'porter2', 'porter ii'],
  '아이오닉 5': ['아이오닉5', 'ioniq5', 'ioniq 5'],
  '아이오닉 6': ['아이오닉6', 'ioniq6', 'ioniq 6'],
  '아이오닉 9': ['아이오닉9', 'ioniq9', 'ioniq 9'],
  'G70': ['g70', 'g 70'],
  'G80': ['g80', 'g 80'],
  'G90': ['g90', 'g 90'],
  'GV60': ['gv60', 'gv 60'],
  'GV70': ['gv70', 'gv 70'],
  'GV80': ['gv80', 'gv 80'],
  '정주영': ['정주영 회장'],
  '정몽구': ['정몽구 회장'],
  '정의선': ['정의선 회장'],
};

// 🔥 앱 로드 시 임베드 데이터로 인덱스를 즉시 생성
try {
  const _pre = (faqEmbed as any[]) || [];
  if (!DOCS.length && Array.isArray(_pre) && _pre.length) {
    buildIndex(_pre as Faq[]);
    if ((import.meta as any)?.env?.DEV) {
      console.log("[RAG] prebuilt from embed:", _pre.length);
    }
  }
} catch (e) {
  console.warn("[RAG] prebuild failed", e);
}
function buildIndex(faqs: Faq[]) {
  DOCS = (faqs || []).map((it) => {
    let text = `${it.q}\n${it.a}`;
    // __ALIAS_EXPANSION__: if canonical exists, append variants to document text
    for (const [canon, vars] of Object.entries(VARIANTS_CANON)) {
      if (text.includes(canon)) text += ' ' + vars.join(' ');
    }
    const toks = tok(text);
    const tf: Record<string, number> = {};
    for (const t of toks) tf[t] = (tf[t] || 0) + 1;
    return { id: it.id, text, url: it.url, toks, tf, len: toks.length };
  });

  AVG_LEN = DOCS.reduce((s, d) => s + d.len, 0) / Math.max(1, DOCS.length);

  const DF = new Map<string, number>();
  for (const d of DOCS) for (const t of new Set(d.toks)) DF.set(t, (DF.get(t) || 0) + 1);

  const N = DOCS.length;
  IDF = new Map([...DF.entries()].map(([t, df]) => [t, Math.log((N - df + 0.5) / (df + 0.5) + 1)]));
}


// ❶ 인덱스 직후 한번만 코퍼스 구성 로그
function logCorpusOnce(label: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g:any = (globalThis as any);
  if (g.__CORPUS_LOGGED__) return;
  g.__CORPUS_LOGGED__ = true;
  // @ts-ignore
  const sample = (DOCS || []).slice(0, 3).map((d:any)=>({id:d.id, text:d.text?.slice(0,60)}));
  console.log('[RAG] corpus', label, 'len=', (g.DOCS?.length ?? DOCS.length), 'sample=', sample);
}

function bm25Score(query: string, d: Doc) {
  const qToks = Array.from(new Set(tok(query)));
  let s = 0;
  for (const t of qToks) {
    const tf = d.tf[t] || 0;
    if (!tf) continue;
    const idf = IDF.get(t) || 0;
    const denom = tf + K1 * (1 - B + B * (d.len / AVG_LEN));
    s += idf * ((tf * (K1 + 1)) / denom);
  }
  return s;
}
// --- RAG index bootstrap (프로덕션 초기 로딩 경쟁 조건 방지) ---
const FAQ_URL = '/faq.json'; // 프로덕션 절대경로 고정

let __ragInit__: Promise<void> | null = null;

async function getFaqHard(): Promise<any[]> {
  // public/faq.json 을 동일출처로 fetch
  const r = await fetch(FAQ_URL, { cache: 'no-store' });
  if (!r.ok) throw new Error(`FAQ fetch failed: ${r.status}`);
  const json = await r.json();
  // 배열 형태만 보장 (schema 느슨하게 방어)
  return Array.isArray(json) ? json : (json?.items ?? []);
}


function ensureRagReady(buildIndex: (docs: any[]) => void) {
  if (!__ragInit__) {
    __ragInit__ = (async () => {
      // 1) embedded corpus (always available)
      const docsA = (faqEmbed as any[]).map((f:any, i:number)=>({
        id: f?.id ?? `faq:${i}`,
        q: f?.q ?? f?.question ?? f?.title ?? '',
        a: f?.a ?? f?.answer ?? f?.content ?? '',
        url: f?.url ?? f?.link ?? ''
      }));
      const docsB = (vehicles as any[]).map((v:any, i:number)=>({
        id: v?.id ?? `veh:${i}`,
        q: v?.model ?? v?.name ?? v?.trim ?? '',
        a: `${v?.segment ?? ''} ${v?.fuel ?? ''} ${v?.summary ?? ''}`.trim(),
        url: v?.url ?? ''
      }));
      const docsC = (centers as any[]).map((c:any, i:number)=>({
        id: c?.id ?? `ctr:${i}`,
        q: c?.name ?? c?.center ?? '',
        a: `${c?.address ?? c?.addr ?? ''}`.trim(),
        url: c?.url ?? ''
      }));
      let merged = [...docsA, ...docsB, ...docsC];

      // 2) runtime /faq.json overrides FAQ portion
      try {
        const r = await fetch('/faq.json', { cache: 'no-store' });
        if (r?.ok) {
          const j = await r.json();
          const arr = Array.isArray(j) ? j : (j?.items ?? []);
          if (arr?.length) {
            const docsR = (arr as any[]).map((f:any, i:number)=>({
              id: f?.id ?? `faq:${i}`,
              q: f?.q ?? f?.question ?? f?.title ?? '',
              a: f?.a ?? f?.answer ?? f?.content ?? '',
              url: f?.url ?? f?.link ?? ''
            }));
            const byId = new Map<string, any>();
            [...docsR, ...docsA].forEach((d: any) => {
              const id = String(d?.id || "");
              if (id && !byId.has(id)) byId.set(id, d);
            });
            merged = [...Array.from(byId.values()), ...docsB, ...docsC];
          }
        }
      } catch {}

      buildIndex(merged as any[]);
      logCorpusOnce('ensureRagReady');
      if ((import.meta as any).env?.DEV) {
        console.log('[RAG] built len=', (globalThis as any).DOCS?.length ?? 0);
      }
    })();
  }
  return __ragInit__!;
}


// 동의어/약어 리라이트(간단)
function rewriteQuery(q: string) {
  let t = (q || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/([가-힣a-z])\s+([0-9]+)/gi, "$1$2")
    .replace(/(ev)\s*([0-9]+)/gi, "$1$2")
    .replace(/(ioniq)\s*([0-9]+)/gi, "$1$2")
    .replace(/[·,，]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // 차량명 variant -> canonical 치환 (정규화의 기준축)
  for (const [canon, vars] of Object.entries(VARIANTS_CANON)) {
    for (const v of vars) {
      const p = v.toLowerCase().replace(/\s+/g, "\\s*");
      t = t.replace(new RegExp(p, "gi"), canon);
    }
  }

  t = t
    .replace(/네비/g, "내비게이션")
    .replace(/내비(?!게이션)/g, "내비게이션")
    .replace(/(지도|맵)\s*업데이트/g, "지도 업데이트")
    .replace(/\bnavi(gation)?\b/g, "내비게이션");

  return t.trim();
}


export async function retrieveFaq(query: string, { k = 4 } = {}) {
  await ensureRagReady(buildIndex);

  const q2 = rewriteQuery(query);

  // 기본 BM25
  let ranked = DOCS
    .map((d) => ({ d, s: bm25Score(q2, d) }))
    .filter((x) => x.s >= MIN_SCORE)
    .sort((a, b) => b.s - a.s)
    .slice(0, k)
    .map(({ d, s }) => ({ id: d.id, text: d.text, url: d.url, score: s }));

  // 폴백 1: 점수 > 0
  if (!ranked.length) {
    const retry = DOCS
      .map((d) => ({ d, s: bm25Score(q2, d) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, k)
      .map(({ d, s }) => ({ id: d.id, text: d.text, url: d.url, score: s }));
    if (retry.length) ranked = retry;
  }

  // 폴백 2: 부분문자열 포함 (변이어 포함)
  if (!ranked.length) {
    const qRaw = rewriteQuery(query);
    const variants = new Set<string>([qRaw]);
    for (const [canon, vars] of Object.entries(VARIANTS_CANON)) {
      if (qRaw.includes(canon)) vars.forEach(v => variants.add(qRaw.replace(canon, v)));
      vars.forEach(v => { if (qRaw.includes(v)) variants.add(qRaw.replace(v, canon)); });
    }
    for (const qv of variants) {
      const hits = DOCS
        .filter((d) => d.text.includes(qv))
        .slice(0, k)
        .map((d) => ({ id: d.id, text: d.text, url: d.url, score: 0 }));
      if (hits.length) { ranked = hits; break; }
    }
  }

  if ((import.meta as any).env?.DEV) {
    console.log('[BM25]', 'retr_total=', DOCS.length, 'retr_k=', ranked.length, 'q=', query, ranked);
  }
  return ranked;
}



// dev-only: window.__bm25("질문", k)
if (typeof window !== "undefined" && (import.meta as any)?.env?.DEV) {
  (window as any).__bm25 = async (q: string, k = 4) => {
    const res = await retrieveFaq(q, { k });
    console.table(res.map((r, i) => ({ rank: i + 1, id: r.id, preview: r.text.slice(0, 60) + "..." })));
    return res;
  };
}

// -----------------------------------------------------------------------------
// Prompt Builders
// -----------------------------------------------------------------------------
function buildPrompt(retr: Array<{ text: string; url?: string }>, userText: string) {
  const ctx = retr.map((r, i) => `# 문서 ${i + 1}\n${r.text}${r.url ? `\nURL: ${r.url}` : ""}`).join("\n\n");

  return [
    "당신은 현대자동차 공식 FAQ 전용 챗봇입니다.",
    "아래 [Retrieved Context] 8개 중 실제로 관련 있는 4개 근거만 사용하세요.",
    "링크나 버튼 안내 문구는 쓰지 말고, 필요한 정보는 문장으로만 간결히 답하세요.",
    "문서에 관련 내용이 없으면, '죄송합니다. 현대자동차 관련 내용만 답변 가능하며, 준비되지 않은 답변일 수 있습니다. 더 궁금하신 내용이 있으신가요?'라고 답하세요.",
    "",
    "[Retrieved Context]",
    ctx,
    "",
    "[User Question]",
    userText,
  ].join("\n");
}

function buildGeneralPrompt(userText: string) {
  return [
    "현대자동차 관련 일반 지식으로 가능한 범위에서 간결히 답하세요.",
    "컨텍스트에 없을 수 있으니 추측을 피하고, 불확실하면 '죄송합니다. 현대자동차 관련 내용만 답변 가능하며, 준비되지 않은 답변일 수 있습니다. 더 궁금하신 내용이 있으신가요?'라고 답하세요.",
    "말풍선에는 인라인 링크/각주/버튼 안내 문구를 넣지 마세요.",
    "",
    "사용자 질문:",
    userText,
  ].join("\n");
}

// -----------------------------------------------------------------------------
// Router
// -----------------------------------------------------------------------------
export async function routeUserText(text: string): 
Promise<BotReply> {
  const rewrittenText = rewriteQuery(text);
  const __coreEntityQuery = isCoreEntityQuery(rewrittenText || text);

  // ✅ EV 추천 하드 매칭 — 함수 진입 직후에 위치해야 함!
  {
    const t = (text ?? '').trim().replace(/[.!?]$/, ''); // 말끝 마침표 제거
    if (/^전기차\s*추천$/i.test(t) || /^전기차\s*모델$/i.test(t)) {
      const reply: BotReply = {
        messages: [],
        chips: [],
        cards: [{ type: 'ev_recommend' }],   // EvInfoCard 렌더
        sticky_cta: null,
      };
      (reply as any).__meta = { path: 'Rule', reason: 'ev_recommend_hard' };
      return reply;
    }
    
    // High-risk OOD guard — 금융/주가/환율 등은 무조건 표준 Fallback
    {
      const raw = (text ?? '').toLowerCase().trim();
      const squished = raw.replace(/\s+/g, '');

      const OOD_FINANCE = /주식|주가|코스피|코스닥|나스닥|s&p|다우|etf|선물|옵션|환율|환전|금리|금값|비트코인|암호화폐|코인|원\/달러|달러\/원|forex|exchange\s*rate|stock|nasdaq|bitcoin/i;

      if (OOD_FINANCE.test(raw) || OOD_FINANCE.test(squished)) {
        const msg = "현대자동차 안내 범위를 벗어난 질문이에요. 차량·서비스 관련 문의를 말씀해 주세요.";
        const reply: BotReply = {
          messages: [msg],
          chips: ["자주 묻는 질문", "처음으로"],
          cards: [],
          sticky_cta: null,
        };
        reply.sticky_cta = buildSupportCTA();
        (reply as any).__meta = { path: "Fallback", reason: "OOD_finance_guard" };
        return reply;
      }
    }

    // High-risk OOD guard — 결제/환불/개인정보/정책 계열은 무조건 표준 Fallback
    {
      const raw = (text ?? '').toLowerCase().trim();
      const squished = raw.replace(/\s+/g, '');

      // 결제/환불/정책/개인정보 키워드
      const OOD_POLICY =
        /(분쟁|클레임|약관|정책|규정|지침|privacy|policy|gdpr|ccpa|개인정보|보관기간|보유기간|파기|열람|정정|삭제|동의철회|동의\s*철회)/i;

      if (OOD_POLICY.test(raw) || OOD_POLICY.test(squished)) {
        const msg =
          "결제/환불·개인정보·정책 관련 문의는 본 챗봇에서 정확히 확인이 어려워요. 공식 고객센터로 연결해 드릴게요.";
        const reply: BotReply = {
          messages: [msg],
          chips: ["자주 묻는 질문", "처음으로"],
          cards: [],
          // 현대 공식 고객센터 연결결
          sticky_cta: buildSupportCTA(),

        };
        (reply as any).__meta = { path: "Fallback", reason: "OOD_policy_guard" };
        return reply;
      }
    }



    // ✅ 차량 스펙(주행거리/연비 등) 직접 응답 — vehicles.json 기반
    {
      const q = rewrittenText.replace(/\s+/g, '');
      const car = (vehicles as any[]).find(v =>
        q.includes(v.id) || q.includes(v.name.replace(/\s+/g,'')) ||
        (v.name.includes('아이오닉') && q.includes('ioniq'))
      );

      if (car && /(주행거리|1회충전|연비|거리|range)/i.test(text)) {
        const msg = `${car.name}의 주행거리는 모델·환경에 따라 다르지만, 최대 ${car.range_km ?? '약 400'}km 수준입니다. 운전 조건에 따라 달라질 수 있어요.`;
        const reply: BotReply = {
          messages: [msg],
          chips: ["혜택", "자주 묻는 질문", "처음으로"],
          cards: [],
          sticky_cta: null,
        };
        (reply as any).__meta = { path: 'Rule', reason: 'vehicle_range_direct' };
        return reply;
      }
    }

  }

  
  // ✅ 충전소 위치 하드매칭 (intent보다 우선 실행)
  {
    const t = (text ?? '').trim();
    if (/(충전소|급속\s*충전기|완속\s*충전기|EV\s*충전소|전기차\s*충전(\s*(위치|지도|장소)?)?)/i.test(t)) {
      const reply: BotReply = {
        messages: cushionMsgs("가까운 전기차 충전소를 확인해 보실 수 있어요."),
        chips: ["전기차 추천", "자주 묻는 질문", "처음으로"],
        cards: [],
        sticky_cta: {
          label: "충전소 지도 열기",
          action: "url",
          id: "https://ev.or.kr/nportal/monitor/evMap.do",
        },
      };
      (reply as any).__meta = { path: "Rule", reason: "open_charger_map_preintent" };
      return reply;
    }
  }

  // ✅ 모델/용어 유사어 사전 (rewriteQuery와 동일 canonical 기준)
  const ALIASES: Record<string, string[]> = VARIANTS_CANON;

  // 역인덱스(variant → canonical)
  const ALIAS_REVERSE = Object.entries(ALIASES).reduce((m, [canon, vars]) => {
    vars.concat([canon]).forEach(v => m.set(v.toLowerCase(), canon));
    return m;
  }, new Map<string, string>());

  // ✅ 한글/영문/숫자 사이 띄어쓰기·기호·유사어 정규화
  function normalizeK(q: string) {
    const s = (q ?? "").trim().normalize("NFKC");

    // 1) 소문자화 (한글은 영향 없음)
    let t = s.toLowerCase();

    // 2) 문장부호/여러 공백 정리
    t = t
      .replace(/[?!.…~]+$/g, "")
      .replace(/[·,，]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    // 3) 수식어/조사 제거(가벼운 수준)
    t = t.replace(/\s*(은가요|인가요|는가요|인가|이야|야)$/g, "");

    // 4) 숫자 붙임: "아이오닉 5" → "아이오닉5", "ev 6" → "ev6"
    t = t
      .replace(/([가-힣a-z])\s+([0-9]+)/gi, "$1$2")
      .replace(/(ev)\s*([0-9]+)/gi, "$1$2")
      .replace(/(ioniq)\s*([0-9]+)/gi, "$1$2");

    // 5) 유사어 → canonical 매핑 (단어 경계 유사 처리)
    //    ex) "아반테", "elantra" → "아반떼"
    for (const [canon, variants] of Object.entries(ALIASES)) {
      const pats = variants.concat([canon]).map(v => v.toLowerCase().replace(/\s+/g, ""));
      const regex = new RegExp(`\\b(${pats.join("|")})\\b`, "gi");
      t = t.replace(regex, canon); // 모두 canonical로 치환
    }

    // 6) 컴팩트 버전(공백 제거) — RAG 보조 쿼리용
    const compact = t.replace(/\s+/g, "");

    return { raw: q ?? "", basic: t, compact };
  }

  // 간단 모델 추출(정규화 뒤)
  function extractCanonicalModel(n: { basic: string }) {
    for (const canon of Object.keys(ALIASES)) {
      if (n.basic.includes(canon)) return canon;
    }
    return null;
  }

  const N = normalizeK(rewrittenText);


  let { intent, entities } = parseIntent(text, rewrittenText);

  // ⬇️ 메타 초기화 + 리라이트 여부 기록
  let __meta: Meta = { path: "RAG" };
  const __rewriteApplied = rewrittenText !== (text || "").toLowerCase().trim();

  // 🔥 [NEW] R3 오버라이드 → Gold 최우선 처리
  try {
    const overrides = await loadOverrides();
    const o = overrides.get(keyQ(text));
    if (o && (o.rating === 'Good' || o.rating === 'Bad' || o.rating === 'Fair')) {
      const faqs = await getFaq();
      const hit = faqs.find(f => norm(f.q) === norm(text));
      if (hit) {
        const msg = guardOutput(hit.a); // ← 5문장 정책 포함 트리밍/세이프티
        const reply: BotReply = {
          messages: [msg],
          chips: ["자주 묻는 질문", "처음으로"],
          cards: [],
          sticky_cta: buildSingleCTA(hit.url ?? null),
        };
        (reply as any).__meta = { path: "RAG", rewriteApplied: __rewriteApplied, primaryUrl: hit.url ?? null, r3_override: true, r3_rating: o.rating };
        return reply;
      }
      // 동일 문장 Gold Q를 못 찾으면 아래 기존 플로우 진행
    }
  } catch (_) {
    // 오버라이드 로딩 실패해도 기존 플로우로 자연스럽게 진행
  }

  // [NEW] 회사 임직원/대표이사 질의는 RAG로 보내지 않고 안전 리다이렉트
  {
    const ORG_PERSONNEL = /(대표이사|ceo|최고\s*경영자|사장|부회장|회장|이사회|임원|리더십|경영진)/i;
    if (ORG_PERSONNEL.test(text)) {
      const reply: BotReply = {
        messages: cushionMsgs(
          "회사 임직원/직함 정보는 변동 가능하여 챗봇에서 확정 제공하지 않아요. 최신 공식 정보는 회사 공식 채널에서 확인해 주세요."
        ),
        chips: ["자주 묻는 질문", "처음으로"],
        cards: [],
        sticky_cta: null,
      };
      (reply as any).__meta = {
        path: "Fallback",
        reason: "org_personnel_redirect",
        rewriteApplied: rewriteQuery(text) !== (text || "").toLowerCase(),
      };
      return reply;
    }
  }
  

  // [NEW] ExactMatch Guard: FAQ 문장과 완전 동일하면 해당 항목의 base id로 즉시 라우팅
  {
    const faqs = await getFaq();
    const exact = (faqs as Faq[]).find(f => norm(f.q) === norm(text));
    if (exact) {
      const base = exact.id.replace(/-(b|c)$/i, ""); // 캐논 id로 통일
      const forced = await answerWithFaqId(base, {
        source: "exact-match",
        bypassHighRisk: true,
        intentHint: "faq",
        noCta: __coreEntityQuery,
        rewriteApplied: rewriteQuery(text) !== (text || "").toLowerCase(),
      });
      if (forced) return forced;
    }
  }


  // [NEW] VariantGuard: B/C 같은 초단문 유사발화를 대표(A)로 선 라우팅
  {
    const guardHit = await guardRouteByGroups(text);
    if (guardHit) {
      const forced = await answerWithFaqId(guardHit.id, {
        source: "variant-guard",
        reason: guardHit.reason,
        bypassHighRisk: true,
        intentHint: "faq",
        noCta: __coreEntityQuery,
        rewriteApplied: rewriteQuery(text) !== (text || "").toLowerCase(),
      });
      if (forced) return forced;
    }
  }
  
  // 홈
  if (intent === "go_home" || /(처음|홈|첫화면)/.test(text)) {
    const reply: BotReply = {
      messages: ["무엇을 도와드릴까요? 현대차 디지털 쇼룸입니다."],
      chips: [],
      cards: [{ type: "home" }],
      sticky_cta: null,
    };
    (reply as any).__meta = { path: "Fallback", rewriteApplied: __rewriteApplied };
    return reply;
  }

  // OOD 키워드: 오픈도메인 OFF이면 차단
  if (!ALLOW_OPEN_DOMAIN && isOOD(text)) {
    const reply = makeFallbackReply(
      ["현대자동차 관련 질문을 주시면 더 정확히 도와드릴 수 있어요."],
      ["혜택", "자주 묻는 질문", "처음으로"]
    );
    (reply as any).__meta = { path: "Fallback", rewriteApplied: __rewriteApplied };
    return reply;
  }
  

  // 하이리스크 주제는 항상 Fallback 고정 응답
  /*if (isHighRisk(text)) {
    const reply = makeFallbackReply([], ["혜택", "자주 묻는 질문", "처음으로"]);
    (reply as any).__meta = { path: "Fallback", rewriteApplied: __rewriteApplied };
    return reply;
  }*/
  
  // 간단 매핑
  if (/(혜택|프로모션|이벤트)/i.test(text)) intent = "show_benefits";
  if (/(자주\s*묻는\s*질문|FAQ|faq|도움말|문의)/i.test(text)) intent = "show_faq";
  if (/(처음으로|처음|홈|첫화면)/i.test(text)) intent = "go_home";
  // 👇 추가: "시승/예약" 전용
  // 유니코드 단어경계 이슈 때문에 '시승' 단독은 트림+정확일치로 처리
  const t1 = (text ?? '').trim().replace(/[.!?]$/, '');

  if (
    /(시승\s*\/\s*예약|시승예약|시승\s*예약|시승\s*신청|드라이빙\s*라운지)/i.test(text)
    || /^시승$/i.test(t1)              // ← 여기 추가 (한글 안전)
  ) {
    intent = "open_testdrive";
  }

  // 공백 제거한 축약 텍스트
  const __norm = text.replace(/\s+/g, '');
  
  

  // ✅ EV 추천 의도
  if (
    /\[EV_RECO\]/.test(text) ||                         // 토큰
    /^(전기차|EV)$/i.test(text.trim()) ||               // 정확히 "전기차" 또는 "EV"만
    /(전기차|EV)\s*(추천|추천해줘|보여줘|모델|라인업)?/i.test(text) || // "전기차 추천/보여줘/모델"
    /^(전기차추천|EV추천|전기차모델|EV모델)$/i.test(__norm)           // 붙여쓰기 형태
  ) {
    intent = "recommend_ev";
  } 



  // Clarify
  // ✅ RAG가 자신 있으면 규칙 유도 스킵
  if (isWeakEvInfo(text) && intent !== "recommend_ev") {
    const pre = await retrieveFaq(N.basic, { k: 1 });
    const top = pre?.[0]?.score ?? 0;
    const looksOOD = isOOD(text);
    const confident = !looksOOD && top >= OOD_THRESHOLD;
    if (!confident) {
      const reply = makeFallbackReply(
        ["어떤 정보를 원하세요?"],
        ["혜택", "자주 묻는 질문", "처음으로"]
      );
      (reply as any).__meta = { path: "Fallback", rewriteApplied: __rewriteApplied, reason: "weak_ev_clarify" };
      return reply;
    }
    // confident → 규칙 분기 스킵, 아래 RAG로 진행
  }


  // ✅ RAG가 자신 있으면 규칙 유도 스킵
  if (isWeakCenter(text) && intent !== "find_service_center") {
    if (/피자|치킨|햄버거/i.test(text)) {
      const reply = makeFallbackReply(
        ["서비스 관련 질문만 도와드릴 수 있어요. 예) 가까운 서비스센터"],
        ["가까운 센터", "예약", "처음으로"]
      );
      (reply as any).__meta = { path: "Fallback", rewriteApplied: __rewriteApplied, reason: "off_topic_center" };
      return reply;
    }

    const pre = await retrieveFaq(N.basic, { k: 1 });
    const top = pre?.[0]?.score ?? 0;
    const looksOOD = isOOD(text);
    const confident = !looksOOD && top >= OOD_THRESHOLD;
    if (!confident) {
      const reply = makeFallbackReply(
        ["센터 관련해서 무엇을 도와드릴까요?"],
        ["가까운 센터", "운영시간", "예약", "드라이빙 라운지", "처음으로"]
      );
      (reply as any).__meta = { path: "Fallback", rewriteApplied: __rewriteApplied, reason: "weak_center_clarify" };
      return reply;
    }
    // confident → 규칙 분기 스킵, 아래 RAG로 진행
  }


  // 출시일 쿠션
  if (/(출시일|출시|언제\s*나오|언제\s*출시)/i.test(text)) {
    const reply: BotReply = {
      messages: cushionMsgs(
        "출시 일정은 공식 발표 전에는 확정 안내가 어려워요. 최신 소식은 현대자동차 공식 사이트/뉴스룸에서 확인하실 수 있어요.",
        { disclaimer: false }
      ),
      chips: ["혜택", "자주 묻는 질문", "처음으로"],
      cards: [],
      sticky_cta: buildSingleCTA("https://www.hyundai.co.kr/news/newsMain"),
    };
    (reply as any).__meta = { path: "Fallback", rewriteApplied: __rewriteApplied, primaryUrl: "https://www.hyundai.co.kr/news/newsMain" };
    return reply;
  }

  // 룰 인텐트들
  if (intent === "recommend_ev") {
    const reply: BotReply = {
      messages: [],                  // 말풍선 없이 카드만
      //chips: ["처음으로"],           // 선택 (원하면 비워도 됨)
      cards: [{ type: "ev_recommend" }], // 👈 EvInfoCard로 렌더됨
      sticky_cta: null,
    };
    (reply as any).__meta = { path: "Fallback", rewriteApplied: __rewriteApplied, reason: "ev_recommend_card" };
    return reply;
  }
  


  if (intent === "find_service_center") {
    // 파라미터
    const wantEV = entities.fuel === "EV" || /(ev|전기|고전압)/i.test(text);
    const coords = pickCoords(text); // ChatPanel에서 geo:use로 재호출되면 파싱됨
  
    // 필터
    let arr = (centers as any[])
      .filter((c) => c.kind === "서비스센터")
      .filter((c) => (entities.city ? String(c.city || "").includes(entities.city!) : true))
      .filter((c) => !wantEV || c.ev_ok === true || (Array.isArray(c.types) && c.types.includes("ev")));
  
    // 정렬
    if (coords) {
      arr = arr
        .map((c) => ({
          ...c,
          distanceKm:
            typeof c.lat === "number" && typeof c.lng === "number"
              ? haversine(coords.lat, coords.lng, c.lat, c.lng)
              : c.distance_km,
        }))
        .sort((a: any, b: any) => (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9));
    } else {
      arr = arr
        .map((c) => ({ ...c, distanceKm: c.distance_km }))
        .sort((a: any, b: any) => (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9));
    }
  
    const list = arr.slice(0, 5).map((c) => ({
      type: "center" as const,
      id: c.id,
      title: c.name,
      kind: c.kind,
      distance_km: c.distanceKm ?? c.distance_km ?? null,
      ev_ok: !!(c.ev_ok || (Array.isArray(c.types) && c.types.includes("ev"))),
      cta: [
        c.mapsUrl    ? { label: "지도", action: "url:open", id: c.mapsUrl } : null,
        c.phone      ? { label: "전화", action: "url:open", id: `tel:${c.phone}` } : null,
        c.bookingUrl ? { label: "예약", action: "url:open", id: c.bookingUrl } : null,
      ].filter(Boolean) as { label: string; action: string; id: string }[],
    }));
  
    const core = coords
      ? (entities.city ? `${entities.city} 기준, 내 위치에서 가까운 서비스센터예요.` : "내 위치 기준으로 가까운 서비스센터예요.")
      : (entities.city ? `${entities.city} 기준 가까운 서비스센터예요.` : "가까운 서비스센터 몇 곳을 보여드려요.");
  
    const reply: BotReply = {
      messages: cushionMsgs(core),
      chips: ["EV 가능만", "운영시간", "처음으로"],
      sticky_cta: coords ? null : { label: "내 위치 기준으로 정렬", action: "geo:use" },
      cards: list,
    };
    (reply as any).__meta = { path: "Fallback", rewriteApplied: __rewriteApplied };
    return reply;
  }

  // ✅ [여기 바로 아래에 추가]
  if (/(가격|가격표|얼마|비용)/i.test(text) && /(아반떼|아이오닉|코나|투싼|쏘나타|팰리세이드)/i.test(text)) {
    const reply: BotReply = {
      messages: cushionMsgs("차량/사양/시점에 따라 달라서 공식 가격표 확인을 안내드릴게요."),
      chips: ["자주 묻는 질문", "처음으로"],
      cards: [],
      sticky_cta: { label: "가격표 보기", action: "price", id: "" },
    };
    (reply as any).__meta = { path: "Rule", reason: "price_redirect" };
    return reply;
  }

  

  // ✅ 근처 서비스센터 자연어 매칭 추가
  if (/(근처|가까운|주변).*(서비스\s*센터|센터)/i.test(text)) {
    const reply: BotReply = {
      messages: cushionMsgs("가까운 서비스센터를 열어드릴게요."),
      chips: ["시승/예약", "자주 묻는 질문", "처음으로"],
      cards: [],
      sticky_cta: { label: "근처 서비스센터 보기", action: "network:service", id: "서비스센터" },
    };
    (reply as any).__meta = { path: "Rule", reason: "open_service_nearby" };
    return reply;
  }
   
  

  if (intent === "ask_price") {
    const reply: BotReply = {
      messages: cushionMsgs("차량 가격은 모델·사양·시점에 따라 달라요. 공식 홈페이지 가격표를 확인해보시겠어요?", {
        disclaimer: true,
      }),
      chips: ["혜택", "자주 묻는 질문", "처음으로"],
      cards: [],
      sticky_cta: buildSingleCTA("https://www.hyundai.com/kr/ko/e/vehicles/catalog-price-download"),
    };
    (reply as any).__meta = {
      path: "RAG",
      rewriteApplied: __rewriteApplied,
      primaryUrl: "https://www.hyundai.com/kr/ko/e/vehicles/catalog-price-download",
    };
    return reply;
  }

  
  // ✅ 보증 intent라도 RAG가 자신 있으면 RAG 우선
  if (intent === "ask_warranty") {
    const pre = await retrieveFaq(N.basic, { k: 1 });
    const top = pre?.[0]?.score ?? 0;
    const spacedBasic = N.basic.replace(/([0-9]+)/g, " $1");
    const looksOOD = isOOD(text) && isOOD(N.basic) && isOOD(spacedBasic);
    const confident = !looksOOD && top >= OOD_THRESHOLD;


    if (!confident) {
      const reply: BotReply = {
        messages: cushionMsgs("현대자동차 보증기간은 차종·부품별로 다릅니다. 기본 보증 안내를 열어드릴까요?", {
          disclaimer: true,
        }),
        chips: ["혜택", "자주 묻는 질문", "처음으로"],
        cards: [],
        sticky_cta: buildSingleCTA("https://www.hyundai.com/kr/ko/purchase-event/policy-Information/warranty/normal-period"),
      };
      (reply as any).__meta = {
        path: "Fallback",
        rewriteApplied: __rewriteApplied,
        primaryUrl: "https://www.hyundai.com/kr/ko/purchase-event/policy-Information/warranty/normal-period",
        reason: "warranty_rule_fallback",
      };
      return reply;
    }
    // confident → 규칙 분기 스킵, 아래 RAG로 진행
  }

  
  

  if (intent === "find_charging_station") {
    // ✅ 충전소 위치 질의 대응
    if (/(충전소|급속\s*충전기|완속\s*충전기|EV\s*충전소)/i.test(text)) {
      const reply: BotReply = {
        messages: cushionMsgs("가까운 전기차 충전소를 확인해 보실 수 있어요."),
        chips: ["전기차 추천", "자주 묻는 질문", "처음으로"],
        cards: [],
        sticky_cta: { label: "충전소 지도 열기", action: "url", id: "https://www.ev.or.kr/charger" },
      };
      (reply as any).__meta = { path: "Rule", reason: "open_charger_map" };
      return reply;
    }  

    const reply: BotReply = {
      messages: cushionMsgs("EV 충전소는 현대차 네트워크 허브에서 바로 확인하실 수 있어요."),
      chips: ["가까운 센터", "운영시간", "처음으로"],
      cards: [],
      sticky_cta: null,
    };
    (reply as any).__meta = { path: "Fallback", rewriteApplied: __rewriteApplied };
    return reply;
  }

  if (intent === "build_quote") {
    const reply: BotReply = {
      messages: cushionMsgs("해당 기능은 곧 오픈 예정입니다."),
      chips: ["전기차 추천", "근처 서비스센터", "처음으로"],
      cards: [],
      sticky_cta: null,
    };
    (reply as any).__meta = { path: "Fallback", rewriteApplied: __rewriteApplied };
    return reply;
  }

  if (intent === "show_benefits") {
    const reply: BotReply = {
      messages: cushionMsgs("현재 이용 가능한 혜택을 안내드릴게요."),
      chips: ["자주 묻는 질문", "처음으로"], // ← 칩은 그대로 유지
      cards: [],
      // ✅ 말풍선 내부 ‘검정 버튼’ (모델 허브를 프로모션 ON으로)
      sticky_cta: { label: "혜택 보기", action: "hub:promo", id: "ALL" },
    };
    (reply as any).__meta = { path: "Fallback", rewriteApplied: __rewriteApplied };
    return reply;
  }

  if (intent === "open_testdrive") {
    const reply: BotReply = {
      messages: cushionMsgs("가까운 드라이빙 라운지를 보여드릴게요."),
      chips: ["근처 서비스센터", "자주 묻는 질문", "처음으로"], // 칩은 보조용
      cards: [],
      // ✅ 말풍선 내부 검정 버튼
      sticky_cta: { label: "시승 및 예약하기", action: "network:testdrive", id: "drive" },
    };
    (reply as any).__meta = { path: "Fallback", reason: "open_testdrive" };
    return reply;
  }
  
  

  // 변경
  if (intent === "show_faq") {
    const reply: BotReply = {
      messages: cushionMsgs("자주 묻는 질문을 모아봤어요."),
      chips: ["혜택", "처음으로"],
      cards: [],
      // ✅ 혜택과 동일한 패턴: 말풍선 내부 '검정 버튼' 제공
      //    프론트에서 이 액션을 받아 메인 칩(자주 묻는 질문)과 동일 로직 실행
      sticky_cta: { label: "자주 묻는 질문 보기", action: "faq:open", id: "faq" },
    };
    (reply as any).__meta = { path: "Fallback", rewriteApplied: __rewriteApplied };
    return reply;
  }


  // ---------------------------------------------------------------------------
  // RAG + Open-domain Fallback
  // ---------------------------------------------------------------------------
  try {
    const t0 = performance.now();

    // 1) Retrieve
    const retr0 = performance.now();

    // 🔁 여기 두 변수는 업데이트가 필요하니 let 으로 선언합니다.
    // ✅ 교체: 초기 BM25도 정규화 질의로
    let retr = await retrieveFaq(N.basic, { k: 8 });
    let retr_ms = performance.now() - retr0;

    // 상위 점수 (let 이어야 아래에서 갱신 가능)
    let topScore = retr?.[0]?.score ?? 0;

    // ✅ 디버그 #1: 1차 검색 직후
    {
      const dbg1 = {
        q: text,
        nb: N.basic,
        retrCount: retr?.length ?? 0,
        topScore,
      };
      console.log("[R3][RAG dbg1]", dbg1);
      (window as any).__lastRag = { ...((window as any).__lastRag||{}), dbg1 };
    }

    console.log("[RAG-test] query:", text, "N.basic:", N.basic, "retr count:", retr?.length, "top:", topScore);


    /* ---------------- Normalization-backed 2nd pass ----------------
      원문 1차 점수가 기준 미만이면 정규화 쿼리(N.basic, N.compact)로
      2차 조회 후 결과를 병합해 점수를 상향 보정합니다. N은 함수 초입에서
      const N = normalizeK(text) 로 이미 계산되어 있어야 합니다. */
    if (topScore < OOD_THRESHOLD) {
      // 추가: 원문으로도 한 번 (레그레션 방지)
      const alt0 = await retrieveFaq(text, { k: 6 });
      const alt1 = await retrieveFaq(N.basic, { k: 8 });
      const alt2 = N.compact !== N.basic ? await retrieveFaq(N.compact, { k: 6 }) : null;

      // 간단 병합(중복은 최고 점수 유지) 후 점수 내림차순
      const pool = [ ...(retr || []), ...(alt0 || []), ...(alt1 || []), ...(alt2 || []) ];
      const seen = new Map<string, any>();
      for (const x of pool) {
        const key = x?.id || x?.url || x?.q || JSON.stringify(x);
        if (!seen.has(key) || (x.score || 0) > (seen.get(key)?.score || 0)) seen.set(key, x);
      }
      retr = Array.from(seen.values()).sort((a, b) => (b.score || 0) - (a.score || 0));
      topScore = retr?.[0]?.score ?? 0;   // ← 실제로 갱신!
    }
    /* ---------------------------------------------------------------- */



    

    // ✅ 하이리스크는 'FAQ 매칭 확신 실패'일 때만 차단
    //    (FAQ로 자신 있게 답할 수 있으면 통과시켜 정상 응답)
    if (isHighRisk(text)) {
      const looksOOD = isOOD(text);
      const isFaqConfident = !looksOOD && topScore >= OOD_THRESHOLD; // 기존 기준 재사용
      if (!isFaqConfident) {
        const reply = makeFallbackReply([], ["혜택", "자주 묻는 질문", "처음으로"]);
        (reply as any).__meta = { path: "Fallback", rewriteApplied: __rewriteApplied, reason: "highrisk_no_confident_faq" };
        return reply;
      }
    }

    // 0건이면 필요한 경우 바로 오픈도메인
    if (!retr || retr.length === 0) {
      if (ALLOW_OPEN_DOMAIN) {
        const gen0: any = await callLLM(buildGeneralPrompt(text), { maxOutputTokens: 350, useMini: true });
        if (gen0?.ok) {
          const out0 = cleanText(guardOutput(gen0.text));
          __meta = {
            path: "OpenDomain",
            rewriteApplied: __rewriteApplied,
            topScore: 0,
            retrievedIds: [],
            model: gen0?.model ?? String(ENV.VITE_MODEL_MINI || "gpt-4o-mini"),
            primaryUrl: null,
            tokens: gen0?.tokens_in || gen0?.tokens_out ? `${gen0.tokens_in ?? "?"}/${gen0.tokens_out ?? "?"}` : undefined,
          };
          const reply: BotReply = {
            messages: cushionMsgs(out0),
            chips: ["혜택", "자주 묻는 질문", "처음으로"],
            cards: [],
            sticky_cta: null, // 오픈도메인/사과 톤은 CTA 숨김
          };
          (reply as any).__meta = __meta;
          return reply;
        }
      }
      recBad();
      logEvent({ route: "rag", status: "fail", fail_reason: "RETR_FAIL", retr_k: 0, retr_ms });
      recTotal(performance.now() - t0);
      const reply = makeFallbackReply(
        ["아직 학습 중이에요. 아래 메뉴에서 골라보시겠어요?"],
        ["혜택", "자주 묻는 질문", "처음으로"]
      );
      (reply as any).__meta = { path: "Fallback", rewriteApplied: __rewriteApplied, topScore: 0, retrievedIds: [] };
      return reply;
    }

    // 2) 프롬프트 선택: OOD 키워드면 무조건 오픈도메인, 아니면 점수로 판정
    // ✅ OOD 판정 개선 — 정규화/붙임/띄움 모두 확인
    const spacedBasic = N.basic.replace(/([0-9]+)/g, " $1"); // 아이오닉5 → 아이오닉 5
    const looksOOD =
      isOOD(text) &&
      isOOD(N.basic) &&
      isOOD(spacedBasic);

    // ✅ 추가: 로깅용 세부 플래그를 실제로 계산
    const looksOOD_text   = isOOD(text);
    const looksOOD_basic  = isOOD(N.basic);
    const looksOOD_spaced = isOOD(spacedBasic);  

    // ✅ 확신도: 점수로 1차, 주행거리/배터리/제원 키워드면 완화
    const specHint = /(주행거리|1회\s*충전|배터리\s*용량|충전\s*시간|제원)/.test(N.basic);
    const isFaqConfident = (!looksOOD && topScore >= OOD_THRESHOLD) || (retr?.length > 0 && specHint);

    // ✅ 디버그 #2: 최종 판정 직전
    {
      const dbg2 = {
        q: text,
        nb: N.basic,
        spacedBasic,
        retrCount: retr?.length ?? 0,
        topScore,
        OOD_THRESHOLD,
        looks: {
          text: looksOOD_text,
          basic: looksOOD_basic,
          spaced: looksOOD_spaced,
          final: looksOOD,
        },
        specHint,
        isFaqConfident,
      };
      console.log("[R3][RAG dbg2]", dbg2);
      (window as any).__lastRag = { ...((window as any).__lastRag||{}), dbg2 };
    }

    // 오픈도메인 결정
    const usingOpenDomain = ALLOW_OPEN_DOMAIN && (looksOOD || !isFaqConfident);


    // 메타 기초 세팅
    __meta.path = usingOpenDomain ? "OpenDomain" : "RAG";
    __meta.topScore = Number(topScore || 0);
    __meta.retrievedIds = (retr || []).map((r) => r.id);
    __meta.rewriteApplied = __rewriteApplied;

    // ✅ RAG 보정 프롬프트용 정규화 입력 보완
    const queryNorm = N.basic || text;

    const prompt = usingOpenDomain
  ? buildGeneralPrompt(queryNorm)
  : buildPrompt(retr, queryNorm);


    // 미니모델 휴리스틱
    const useMini = text.length <= 20 && !/(보증|가격|프로모션|리콜|보조금)/.test(text);

    let gen: any = await callLLM(prompt, { maxOutputTokens: 400, useMini });

    // 모델/토큰 메타
    __meta.model =
      gen?.model ?? (useMini ? String(ENV.VITE_MODEL_MINI || "gpt-4o-mini") : String(ENV.VITE_MODEL_PRIMARY || "gpt-4o"));
    if (gen?.tokens_in || gen?.tokens_out) {
      __meta.tokens = `${gen.tokens_in ?? "?"}/${gen.tokens_out ?? "?"}`;
    }

    // ✅ 추가: 미니모델 실패 시 프라이머리로 1회 재시도 (쿼터가 아닌 경우에만)
    if (!gen.ok) {
      const isQuota = String(gen.error || "").includes("http 429") || gen.code === 429;
      if (!isQuota && useMini) {
        console.warn("[R3][RAG] mini failed; retry with primary model");
        const gen2: any = await callLLM(prompt, { maxOutputTokens: 400, useMini: false });
        if (gen2?.ok) gen = gen2; // 재시도 성공 시 교체
      }

      // 재시도 후에도 실패면 기존 처리 유지
      if (!gen.ok) {
        if (isQuota) {
          const out = cleanText(guardOutput(retr.map((r) => r.text).join("\n\n")));
          const suppressCta = usingOpenDomain || APOLOGY_REGEX.test(out);
          const primaryUrl = suppressCta ? null : pickPrimaryUrl(retr);
          __meta.primaryUrl = primaryUrl;
          const reply: BotReply = {
            messages: cushionMsgs(out),
            chips: ["혜택", "자주 묻는 질문", "처음으로"],
            cards: [],
            sticky_cta: __coreEntityQuery ? null : buildSingleCTA(primaryUrl),
          };
          (reply as any).__meta = __meta;
          return reply;
        }

        recBad();
        logEvent({ route: "rag", status: "fail", fail_reason: "OTHER", retr_k: retr.length, retr_ms });
        const out = cleanText(guardOutput(retr.map((r) => r.text).join("\n\n")));
        const suppressCta = usingOpenDomain || APOLOGY_REGEX.test(out);
        const primaryUrl = suppressCta ? null : pickPrimaryUrl(retr);
        __meta.primaryUrl = primaryUrl;
        const reply: BotReply = {
          messages: cushionMsgs(out || fallbackMessage()),
          chips: ["혜택", "자주 묻는 질문", "처음으로"],
          cards: [],
          sticky_cta: __coreEntityQuery ? null : buildSingleCTA(primaryUrl),
        };
        (reply as any).__meta = { ...__meta, reason: "llm_nonquota_fallback" };
        return reply;
      }
    }

    // 모델/토큰 메타는 재시도까지 반영된 gen 기준으로 셋팅
    __meta.model =
      gen?.model ?? (useMini ? String(ENV.VITE_MODEL_MINI || "gpt-4o-mini") : String(ENV.VITE_MODEL_PRIMARY || "gpt-4o"));
    if (gen?.tokens_in || gen?.tokens_out) {
      __meta.tokens = `${gen.tokens_in ?? "?"}/${gen.tokens_out ?? "?"}`;
    }

    // 3) 성공 응답
    const out = cleanText(guardOutput(gen.text));
    const suppressCta = usingOpenDomain || APOLOGY_REGEX.test(out);
    const primaryUrl = suppressCta ? null : pickPrimaryUrl(retr);

    __meta.primaryUrl = primaryUrl;

    recGood();
    logEvent({
      route: usingOpenDomain ? "open_domain" : "rag",
      status: "pass",
      retr_k: retr.length,
      retr_ms,
      llm_ms: gen.ms,
    });
    recTotal(performance.now() - t0);

    const reply: BotReply = {
      messages: cushionMsgs(out),
      chips: ["혜택", "자주 묻는 질문", "처음으로"],
      cards: [],
      sticky_cta: __coreEntityQuery ? null : buildSingleCTA(primaryUrl),
    };
    (reply as any).__meta = __meta;
    return reply;
  } catch (e) {
    recBad();
    logEvent({ route: "rag", status: "fail", fail_reason: "OTHER" });
    const reply = makeFallbackReply(
      ["아직 학습 중이에요. 아래 메뉴에서 골라보시겠어요?"],
      ["혜택", "자주 묻는 질문", "처음으로"]
    );
    (reply as any).__meta = { path: "Fallback", rewriteApplied: rewriteQuery(text) !== (text || "").toLowerCase() };
    return reply;
  }

}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------
export async function handleUserText(text: string): Promise<BotReply> {
  const t0 = performance.now();

  // [SAFETY-IN]
  const gate = moderateInput(text);
  if (gate.action === "block") {
    recBad();
    recTotal(performance.now() - t0);
    return { messages: [COPY.safetyNotice], chips: [], cards: [], sticky_cta: null };
  }
  if (gate.action === "redirect") {
    recBad();
    recTotal(performance.now() - t0);
    return {
      messages: [COPY.hyundaiEvalFallback],
      chips: ["혜택", "자주 묻는 질문", "처음으로"],
      cards: [],
      sticky_cta: null,
    };
  }

  const reply = await routeUserText(text);

  // [SAFETY-OUT]
  reply.messages = reply.messages.map((m) => sanitizeOutput(m));
  recTotal(performance.now() - t0);
  return reply;
}

// ⬇️ 추가: 회귀·콘솔용 얇은 엔트리 (브라우저/배치 러너 공용)
export async function runOnce(q: string) {
  // runOnce(q: string) 내부 가장 앞쪽
  const overrides = await loadOverrides();
  const o = overrides.get(keyQ(q));
  if (o && (o.rating === 'Good' || o.rating === 'Bad' || o.rating === 'Fair')) {
    // 1) Gold에서 동일질문 매칭(정확 문장 기준)
    const faq = await getFaq();
    const fq = faq.find(f => norm(f.q) === norm(q));
    if (fq) {
      // 오버라이드: 곧장 gold 답/URL을 반환
      // ✅ 5문장 정책 + CTA action 통일
      return {
        messages: [guardOutput(fq.a)],
        sticky_cta: fq.url ? { label: '공식 안내 보기', action: 'url:open', id: fq.url } : null,
        r3_override: true,
        r3_rating: o.rating,
        r3_reason: o.reason || ''
      };
    }
    // 2) 혹시 동일 문장이 faq에 없으면 BM25 등 기존 로직으로 폴백
  }

  const reply = await handleUserText(q);
  const meta = (reply as any).__meta ?? {};
  return {
    text: (reply.messages || []).join("\n\n"),
    meta,
  };
}

// dev 전용: 콘솔에서 바로 쓰게 전역 노출
if (typeof window !== 'undefined' && (import.meta as any)?.env?.DEV) {
  (window as any).runOnce  = runOnce;       // 질의 1회 테스트
  (window as any).__getFaq = async () => await getFaq(); // 앱이 들고 있는 FAQ 리스트
}

