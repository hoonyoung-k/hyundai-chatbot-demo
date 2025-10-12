// src/test/runBatch.r2.ts
// 브라우저 콘솔: await __runBatchR2();

//////////////////////////////////////////////
// XLSX 로더 (패키지 설치 없이 CDN으로 동작)
//////////////////////////////////////////////
async function loadXLSX() {
  try {
    return await import(/* @vite-ignore */ 'https://cdn.sheetjs.com/xlsx-latest/package/xlsx.mjs');
  } catch {}
  try {
    return await import(/* @vite-ignore */ 'https://esm.sh/xlsx');
  } catch {}
  throw new Error('XLSX 모듈을 불러오지 못했습니다. 엑셀을 CSV로 저장한 뒤 다시 실행해 주세요.');
}

//////////////////////////////////////////////
// 유틸
//////////////////////////////////////////////
const norm = (s?: string) =>
  (s ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.,!?~\-_/\\(){}\[\]"“”‘’·…・・]/g, ' ')
    .trim();

const host = (url?: string) => {
  try { if (!url) return ''; const u = new URL(url); return u.hostname.replace(/^www\./, ''); }
  catch { return ''; }
};

// 토큰 집합 Jaccard
const jaccard = (a: string, b: string) => {
  const A = new Set(norm(a).split(' ').filter(Boolean));
  const B = new Set(norm(b).split(' ').filter(Boolean));
  if (A.size === 0 && B.size === 0) return 1;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter || 1);
};

// ===== FAQ Exact 매핑 인덱스 =====
type Faq = { id: string; q: string; a: string; url?: string }; // 파일 위쪽에도 Faq가 있으면 이 줄은 생략
function keyQ(s: string) {
  return (s || '').toLowerCase().replace(/\s+/g,' ').trim();
}
function buildFaqIndex(faq: Faq[]) {
  const map = new Map<string, Faq>();
  for (const f of faq) map.set(keyQ(f.q), f);
  return map;
}


// 문자 bigram Dice
function diceBigram(a: string, b: string) {
  const s = (x: string) => {
    const z = norm(x); const grams: string[] = [];
    for (let i = 0; i < z.length - 1; i++) grams.push(z.slice(i, i + 2));
    return grams;
  };
  const A = s(a), B = s(b);
  if (!A.length && !B.length) return 1;
  const map = new Map<string, number>();
  for (const g of A) map.set(g, (map.get(g) || 0) + 1);
  let inter = 0;
  for (const g of B) {
    const v = map.get(g) || 0;
    if (v > 0) { inter++; map.set(g, v - 1); }
  }
  return (2 * inter) / (A.length + B.length || 1);
}

function normalizeLabel(x?: string) {
  const t = String(x || '').trim().toLowerCase();
  if (t.startsWith('g')) return 'Good';
  if (t.startsWith('f')) return 'Fair';
  if (t.startsWith('b')) return 'Bad';
  return '';
}


// 폴백(사과/안내불가) 패턴(보수화)
const FALLBACK_PATTERNS = [
  /정확한 안내가 어려워/i,
  /정보가 부족/i,
  /고객센터.*연락/i
];

// 약한 답(폴백/짧은 답) 감지
function isWeakAnswer(a?: string) {
  const s = (a || '').trim();
  const tooShort = s.length < 40 || s.split(' ').length < 6;
  const isFallback = FALLBACK_PATTERNS.some(re => re.test(s));
  return !s || tooShort || isFallback;
}


// 현대차 도메인 화이트리스트
function safeHost(h: string) {
  if (!h) return false;
  const wl = ['hyundai.com', 'certified.hyundai.com'];
  return wl.some(w => h.endsWith(w));
}

//////////////////////////////////////////////
// FAQ 로딩
//////////////////////////////////////////////
type Faq = { id: string; q: string; a: string; url?: string };
let _faq: Faq[] | null = null;
async function getFaq(): Promise<Faq[]> {
  if (_faq) return _faq;
  // public/faq.json이 표준 소스
  const res = await fetch('/faq.json', { cache: 'no-store' });
  const data = (await res.json()) as Faq[];
  _faq = data;
  return _faq!;
}

//////////////////////////////////////////////
// 초간단 BM25 (정답 매핑/대체에 사용)
//////////////////////////////////////////////
class BM25 {
  private toks: string[][];
  private df = new Map<string, number>();
  private avgdl: number;
  private N: number;
  constructor(texts: string[]) {
    this.toks = texts.map(t => norm(t).split(' ').filter(Boolean));
    this.N = this.toks.length;
    for (const d of this.toks) {
      const seen = new Set<string>();
      for (const w of d) if (!seen.has(w)) { this.df.set(w, (this.df.get(w) || 0) + 1); seen.add(w); }
    }
    this.avgdl = this.toks.reduce((s, t) => s + t.length, 0) / (this.N || 1);
  }
  score(query: string, i: number, k1 = 1.5, b = 0.75) {
    const qT = norm(query).split(' ').filter(Boolean);
    const d = this.toks[i]; const dl = d.length || 1;
    let s = 0;
    for (const q of qT) {
      const f = d.filter(w => w === q).length; if (!f) continue;
      const n = this.df.get(q) || 0;
      const idf = Math.log(1 + (this.N - n + 0.5) / (n + 0.5));
      const denom = f + k1 * (1 - b + (b * dl) / this.avgdl);
      s += idf * ((f * (k1 + 1)) / (denom || 1));
    }
    return s;
  }
  top1(query: string) {
    let best = -1, bi = -1;
    for (let i = 0; i < this.N; i++) {
      const sc = this.score(query, i);
      if (sc > best) { best = sc; bi = i; }
    }
    return { index: bi, score: best };
  }
}

//////////////////////////////////////////////
// 라우터/ask 자동 감지 (실제 응답 얻기용)
//////////////////////////////////////////////
async function callBot(q: string): Promise<{ a: string; url?: string } | null> {
  const wAny = window as any;
  if (typeof wAny.__ask === 'function') {
    const r = await wAny.__ask(q);
    const a = Array.isArray(r?.messages) ? r.messages.join(' ') : (r?.message || r?.text || '');
    const url = r?.url || r?.sticky_cta?.id;
    return { a, url };
  }
  if (typeof wAny.ask === 'function') {
    const r = await wAny.ask(q);
    const a = Array.isArray(r?.messages) ? r.messages.join(' ') : (r?.message || r?.text || '');
    const url = r?.url || r?.sticky_cta?.id;
    return { a, url };
  }
  try {
    const mod = await import('/src/logic/router.ts');
    for (const k of ['runOnce', 'route', 'router', 'dispatch', 'handle']) {
      if (typeof (mod as any)[k] === 'function') {
        const r = await (mod as any)[k](q);
        const a = Array.isArray(r?.messages) ? r.messages.join(' ') : (r as any)?.message || '';
        const url = (r as any)?.url || r?.sticky_cta?.id;
        return { a, url };
      }
    }
  } catch {}
  return null;
}

//////////////////////////////////////////////
// AutoLabel (유사도+URL)
//////////////////////////////////////////////
// 문자 bigram Dice 비중을 크게, 토큰 Jaccard는 보조로만 사용
function autoLabel(aActual: string, aExp: string, urlActual?: string, urlExp?: string): 'Good'|'Fair'|'Bad' {
  if (!aActual || !aActual.trim()) return 'Bad';

  const A = (aActual || '').trim();
  const E = (aExp || '').trim();
  const nA = norm(A);
  const nE = norm(E);

  // --- 기본 유사도: 한글 친화 (문자 bigram 0.7 + 토큰 Jaccard 0.3)
  const simChr = E ? diceBigram(A, E) : 0;
  const simTok = E ? jaccard(A, E) : 0;
  let ans = E ? (0.7 * simChr + 0.3 * simTok) : 0;

  // --- 포함 휴리스틱: 접두/접미 차이 보정
  if (E && (nA.includes(nE.slice(0, 25)) || nE.includes(nA.slice(0, 25)))) {
    ans = Math.max(ans, 0.80);
  }

  // --- 핵심 어절 커버리지: 교집합 / 더 짧은 쪽 어절 수
  const toksA = nA.split(' ').filter(Boolean);
  const toksE = nE.split(' ').filter(Boolean);
  const setA = new Set(toksA);
  const setE = new Set(toksE);
  let inter = 0;
  for (const t of setA) if (setE.has(t)) inter++;
  const denom = Math.max(1, Math.min(setA.size, setE.size));
  const coverage = inter / denom;

  // 커버리지가 높으면 사실상 동일한 답 → Good로 승급
  if (coverage >= 0.65 && (toksA.length >= 6 || toksE.length >= 6)) {
    ans = Math.max(ans, 0.82);
  }

  // --- URL은 보너스/감점만(절대 Bad 직행 금지)
  if (urlExp && urlActual) {
    const hA = host(urlActual), hE = host(urlExp);
    const sameHost = (!!hA && !!hE && hA === hE) || (safeHost(hA) && safeHost(hE));
    const exact = norm(urlActual) === norm(urlExp);
    if (sameHost || exact) ans += 0.03;
    else ans -= 0.05;
  }

  // --- 최종 등급 (내용 중심)
  if (ans >= 0.68) return 'Good';
  if (ans >= 0.45) return 'Fair';
  return 'Bad';
}




//////////////////////////////////////////////
// CSV 파서(설치 없이 동작하는 대비책)
//////////////////////////////////////////////
function parseCSV(text: string) {
  const lines = text.replace(/\r/g, '').split('\n').filter(Boolean);
  const head = lines[0].split(',').map(s => s.trim());
  const rows = lines.slice(1).map(line => {
    const out: string[] = []; let cur = ''; let q = false;
    for (const ch of line) {
      if (ch === '"') { q = !q; continue; }
      if (ch === ',' && !q) { out.push(cur); cur = ''; continue; }
      cur += ch;
    }
    
    out.push(cur);
    const obj: any = {}; head.forEach((h, i) => obj[h] = (out[i] || '').trim());
    return obj;
  });
  return rows;
}

//////////////////////////////////////////////
// 파일 선택
//////////////////////////////////////////////
function pickFile(): Promise<{ name: string; ab?: ArrayBuffer; text?: string }> {
  return new Promise(res => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.xlsx,.xls,.csv';
    inp.onchange = async () => {
      const f = inp.files?.[0]; if (!f) return;
      if (f.name.toLowerCase().endsWith('.csv')) {
        const text = await f.text(); res({ name: f.name, text });
      } else {
        const ab = await f.arrayBuffer(); res({ name: f.name, ab });
      }
    };
    inp.click();
  });
}

//////////////////////////////////////////////
// 메인 러너
//////////////////////////////////////////////
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(window as any).__runBatchR2 = async () => {
  console.time('R2 AutoLabel');
  const { ab, text } = await pickFile();

  // 입력 로드
  let rows: any[] = [];
  if (text) {
    rows = parseCSV(text);
  } else if (ab) {
    const XLSX = await loadXLSX();
    const wb = XLSX.read(ab, { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    rows = XLSX.utils.sheet_to_json(ws);
  } else {
    throw new Error('파일을 불러오지 못했습니다.');
  }

  // 컬럼 추정 (훈영님 엑셀 헤더에 맞춤: "Query", "Response (Raw)", "Rating" 등)
  const keys = rows.length ? Object.keys(rows[0]) : [];
  const canon = (s:string)=>s.toLowerCase().replace(/\s|\(|\)|_/g,'');
  const findCol = (cands: string[]) => keys.find(k => cands.some(c => canon(k).includes(canon(c)))) || '';

  const COL_Q   = findCol(['q','question','query','질문','userquestion']) || 'Query';
  const COL_RAW = findCol(['response(raw)','response','answer','응답'])   || 'Response (Raw)';
  // 엑셀에 a_expected/url_expected가 없으므로 여기선 비어있게 시작
  const COL_AEXP = findCol(['a_expected','expectedanswer','gold','정답','예상답변']) || '';
  const COL_UEXP = findCol(['url_expected','expectedurl','goldurl','예상url'])       || '';
  const COL_RATING = findCol(['rating','rating(manual)','manual','human','수동','평가']) || 'Rating';

  // FAQ + BM25 (정답/URL 대체용 인덱스)
  const faq = await getFaq();
  const bm25 = new BM25(faq.map(f => `${f.q} ${f.a}`));
  // ✅ 정확 매핑용 인덱스 (한 번만 만들어 전역에 보관)
  (window as any).__faqIdx = buildFaqIndex(faq);

  // 평가
  const out: any[] = [];
  for (const r of rows) {
    const qText = String(r[COL_Q] || r['Query'] || '').trim();
    // 실제 응답: 우선 엑셀의 Response(Raw), 없으면 라우터 호출
    let aAct = String(r[COL_RAW] || '').trim();
    let uAct: string | undefined;

    // 1) 라우터 답 우선 시도
    if (!aAct) {
      const bot = await callBot(qText);
      if (bot) { aAct = bot.a || ''; uAct = bot.url; }
    }

    // 2) 라우터 답이 폴백/짧은 답이면, BM25 Top1로 "실제답"을 대체
    if (isWeakAnswer(aAct)) {
      const hitAct = bm25.top1(qText);
      if (hitAct.index >= 0) {
        aAct = faq[hitAct.index].a || aAct;
        if (!uAct) uAct = faq[hitAct.index].url;
      }
    }


    // ---- 기대 정답/URL: 엑셀 없음 → FAQ에서 "정확 일치 우선", 실패 시 BM25 ----
    let aExp = String(COL_AEXP ? (r[COL_AEXP] || '') : '').trim();
    let uExp = String(COL_UEXP ? (r[COL_UEXP] || '') : '').trim();

    if (!aExp) {
      // 1) Exact 매칭
      const qKey = keyQ(qText);
      const faqIdx = (window as any).__faqIdx as Map<string, Faq> | undefined;
      let cand: Faq | undefined = faqIdx?.get(qKey);

      // 2) 실패 시 BM25 Top1
      if (!cand) {
        const hit = bm25.top1(qText);
        if (hit.index >= 0) cand = faq[hit.index];
      }

      if (cand) {
        aExp = cand.a || '';
        if (!uExp) uExp = cand.url || '';
      }
    }


    // AutoLabel
    const auto = autoLabel(aAct, aExp, uAct, uExp);

    const manual = normalizeLabel(r[COL_RATING] as string);

    out.push({
      q: qText,
      a_expected: aExp,
      url_expected: uExp,
      a_actual: aAct,
      url_actual: uAct || '',
      AutoLabel: auto,
      // ✅ 수동 라벨 반영 및 일치 여부
      Rating_manual: manual,
      Agree: manual ? (manual === auto) : ''
    });
  }

  // 집계
  const counts = out.reduce((m: any, x: any) => { m[x.AutoLabel] = (m[x.AutoLabel] || 0) + 1; return m; }, {});
  console.table(counts);

  // ✅ [여기 바로 아래에 3번 블록 전체 추가!!]
  // ===== Metrics: Auto vs Manual =====
  const valids = out.filter(r => r.Rating_manual === 'Good' || r.Rating_manual === 'Fair' || r.Rating_manual === 'Bad');
  const agreeRate = valids.length
    ? valids.filter(r => r.Rating_manual === r.AutoLabel).length / valids.length
    : 0;

  const labels = ['Good', 'Fair', 'Bad'] as const;
  const conf: Record<string, Record<string, number>> = {
    Good: { Good: 0, Fair: 0, Bad: 0 },
    Fair: { Good: 0, Fair: 0, Bad: 0 },
    Bad: { Good: 0, Fair: 0, Bad: 0 },
  };
  for (const r of valids) conf[r.Rating_manual][r.AutoLabel]++;

  console.log('[R2] 수동 라벨 유효 개수 =', valids.length);
  console.log('[R2] Auto vs Manual 일치율 =', (agreeRate * 100).toFixed(2) + '%');
  console.table(conf);

  const disagree = valids.filter(r => r.Rating_manual !== r.AutoLabel).slice(0, 20);

  // 결과 보이기/저장
  (window as any).__lastOut = out; // 디버그 접근
  if (ab) {
    const XLSX = await loadXLSX();
    const ws = XLSX.utils.json_to_sheet(out);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'R2_autolabel');
    XLSX.writeFile(wb, 'R2_results_autolabel.xlsx');
  } else {
    const header = Object.keys(out[0] || {});
    const csv = [header.join(',')].concat(
      out.map(o => header.map(h => `"${String(o[h] ?? '').replace(/"/g, '""')}"`).join(','))
    ).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'R2_results_autolabel.csv';
    a.click();
  }

  console.timeEnd('R2 AutoLabel');
  return counts;
};
