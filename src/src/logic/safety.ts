// src/logic/safety.ts

// ---------- Types ----------
export type SafetyDecision =
  | { action: 'block'; reason: string }
  | { action: 'redirect'; reason: 'hyundai-eval' }
  | { action: 'pass'; reason?: string };

// ---------- Regexes (PII/Profanity) ----------

// 한국 전화번호: 010-1234-5678 / 01012345678 / 02-123-4567 등
export const PHONE_RE =
  /\b(?:(?:01[016789]|02|0[3-6][1-5]|0[7-9]\d))[-.\s]?\d{3,4}[-.\s]?\d{4}\b/gi;

// 주민등록번호: 900101-1234567 (다양한 하이픈 유니코드 포함)
export const SSN_RE = /\b\d{6}[-‐-‒–—−]?\d{7}\b/gi;

// 17자리 VIN (I,O,Q 제외)
export const VIN_RE = /\b[A-HJ-NPR-Z0-9]{17}\b/gi;

// PII 패턴 모음 (입력 탐지/출력 마스킹 공용)
const PII_PATTERNS: RegExp[] = [PHONE_RE, SSN_RE, VIN_RE];

// 욕설 (단독)
const PROFANITY_RE = new RegExp(
  [
    '(?:멍청(?:이|아)?|바보|등신|또라이|정신병자)',
    '(?:병신|미친놈|미친년)',
    '(?:개새끼|개새|개같|개소리)',
    '(?:지랄|꺼져|엿먹|쓰레기)',
    '(?:씹|좆|좆같|ㅈ같|좇같)'
  ].join('|'),
  'i'
);

// 브랜드 + 욕설 (현대/Hyundai와 결합된 경우)
const BRAND_ABUSE_RE = new RegExp(
  [
    '(?:현대\\s*자동차|현대차|Hyundai).{0,6}(?:개|X|좆|ㅈ|xx)같',
    '(?:개|X|좆|ㅈ|xx)같.{0,6}(?:현대\\s*자동차|현대차|Hyundai)'
  ].join('|'),
  'i'
);

// 불법/위험 행위 (하드블록)
const ILLEGAL_OR_DANGEROUS =
  /(음주\s*운전|불법\s*튜닝|폭발물|해킹|테러|마약|자살|살인|아동\s*학대|성\s*착취)/i;

// 현대차 인물/회사 ‘평가/비방/호불호’ → 범위 밖 리다이렉트
const HYUNDAI_EVAL =
  /(현대\s*차|현대자동차|HMG|Hyundai)[^.\n]{0,12}(평가|평판|비판|욕|별로|실망|어때|어떤가)/i;

// ---------- Safety Ingress ----------
export function moderateInput(text: string): SafetyDecision {

  // ⬇️ [NEW] 디지털키 앱 오류 문의는 세이프티 통과 (화이트리스트)
  const lower = text.toLowerCase();
  const hasDigitalKey = /(디지털\s*키|디지털키|digital\s*key)/.test(lower);
  const hasAppCrash = /(꺼져|튕기|종료|오류|안\s*열|실행\s*안됨|자동\s*종료)/.test(lower);
  if (hasDigitalKey && hasAppCrash) {
    return { action: 'pass', reason: 'benign-app-issue' }; // ✅ 세이프티 통과
  }
  
  // 욕설/브랜드 비방 → 하드블록
  if (PROFANITY_RE.test(text) || BRAND_ABUSE_RE.test(text)) {
    return { action: 'block', reason: 'hardblock' };
  }

  // 불법/위험 행위 → 하드블록
  if (ILLEGAL_OR_DANGEROUS.test(text)) {
    return { action: 'block', reason: 'hardblock' };
  }

  // 현대차 인물/회사 평가/비방 → 리다이렉트
  if (HYUNDAI_EVAL.test(text)) {
    return { action: 'redirect', reason: 'hyundai-eval' };
  }

  // PII 포함은 차단하지 않고 통과 → 출력에서 마스킹
  if (PII_PATTERNS.some((rx) => rx.test(text))) {
    return { action: 'pass', reason: 'pii' };
  }

  return { action: 'pass' };
}

// ---------- Safety Egress (Masking) ----------
export function sanitizeOutput(s: string): string {
  if (!s) return '';

  let out = String(s).replace(/<[^>]+>/g, '').trim();

  // ✅ 공식 고객센터 번호 화이트리스트
  const whitelist = [
    '080-600-6000',
    '1577-6000',
    '1577-5353',
    '1588-6000',
    '1588-2580',
    '080-600-6003'
  ];

  // 전화번호 마스킹 (화이트리스트 제외)
  out = out.replace(PHONE_RE, (m) =>
    whitelist.includes(m) ? m : '***-****-****'
  );

  // 주민등록번호, VIN은 기존처럼 마스킹
  out = out
    .replace(SSN_RE, '******-*******')
    .replace(VIN_RE, '*****************');

  return out;
}

// ---------- Copy ----------
export const COPY = {
  safetyNotice:
    '안전 및 이용 정책에 따라 해당 요청은 안내드릴 수 없습니다. 필요 시 공식 고객센터로 연결해드릴게요.',
  hyundaiEvalFallback:
    '저는 현대자동차 차량/서비스 안내를 위한 챗봇입니다. 회사/임직원 평가 대신 차량·서비스 관련 질문을 주시면 도와드릴게요.',
  piiNotice:
    '개인정보(전화번호/주민번호/VIN)는 채팅에 입력하지 말아 주세요. 필요 시 공식 채널을 이용해 주세요.',
  finalFallback:
    '지금은 확답이 어렵습니다. 고객센터 연결/지점 안내/FAQ 보기 중 선택해 주세요.',
};

// ---------- Cushion helpers ----------
export function cushionMsgs(
  core: string,
  opts?: { disclaimer?: boolean }
): string[] {
  const msgs = [core];
  if (opts?.disclaimer) {
    msgs.push(
      '※ 가격·보증·프로모션은 지역/시점/사양에 따라 상이하며, 공식 경로 기준입니다.'
    );
  }
  return msgs;
}

// router.ts 호환(별칭)
export function withCushion(core: string, opts?: { disclaimer?: boolean }) {
  return cushionMsgs(core, opts);
}
