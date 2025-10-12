// src/logic/safety-guard.ts
import { moderateInput, sanitizeOutput } from './safety';

export async function guardInput(userText: string) {
  const decision = moderateInput(userText);
  // 허용되는 경우: pass (PII 포함 pass 도 허용하고 출력에서 마스킹)
  if (decision.action === 'pass') {
    return { allow: true as const };
  }
  // 나머지는 모두 차단/리다이렉트로 취급
  const reason =
    decision.action === 'redirect' ? 'POLICY_REDIRECT' : 'POLICY_BLOCK';
  return { allow: false as const, reason };
}

type LengthPolicy = {
  maxSentences?: number;   // 기본 5
  maxBullets?: number;     // 기본 4
  maxChars?: number;       // 기본 420 (한글 기준)
};
const LENGTH_POLICY_DEFAULT: LengthPolicy = {
  maxSentences: 5,
  maxBullets: 4,
  maxChars: 420,
};

function isBulletLine(line: string) {
  return /^[\-\*\•\u2022]\s+/.test(line) || /^\d+\.\s+/.test(line);
}
function splitSentences(s: string): string[] {
  const clean = (s || '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  // 문장 경계: . ! ? … + 공백 / 줄바꿈
  return clean.split(/(?<=[\.!?…])\s+|\n+/g).map(x => x.trim()).filter(Boolean);
}

export function trimByPolicy(text: string, policy: LengthPolicy = {}) {
  const maxSentences = policy.maxSentences ?? LENGTH_POLICY_DEFAULT.maxSentences!;
  const maxBullets   = policy.maxBullets   ?? LENGTH_POLICY_DEFAULT.maxBullets!;
  const maxChars     = policy.maxChars     ?? LENGTH_POLICY_DEFAULT.maxChars!;

  if (!text) return '';

  // 1) 불릿 라인 수 제한
  const lines = text.trim().split(/\n+/g);
  let bulletCount = 0;
  const keptLines: string[] = [];
  for (const ln of lines) {
    if (isBulletLine(ln)) {
      if (bulletCount < maxBullets) {
        keptLines.push(ln.trim());
        bulletCount++;
      } else {
        continue; // 초과 불릿 제거
      }
    } else {
      keptLines.push(ln.trim());
    }
  }
  let out = keptLines.join('\n').trim();

  // 2) 문장 수 제한 (줄바꿈은 문장 경계로 취급)
  const sentenceFeed = out.replace(/\n+/g, '. ');
  const sentences = splitSentences(sentenceFeed).slice(0, maxSentences);
  let joined = sentences.join(' ');

  // 3) 글자 수 제한 (문장 경계 우선)
  if (joined.length > maxChars) {
    const upTo = joined.slice(0, maxChars + 30);
    const re = /[\.!?…]\s|\n/g;
    let lastIdx = -1, m: RegExpExecArray | null;
    while ((m = re.exec(upTo)) !== null) {
      if (m.index <= maxChars) lastIdx = m.index + m[0].length;
      else break;
    }
    joined = (lastIdx === -1 ? joined.slice(0, maxChars).trim() + ' …' : upTo.slice(0, lastIdx).trim());
  }
  return joined;
}

// ────────────────────────────────────────────────────────────────────────────
// ✅ 변경: 출력 가드가 항상 트리밍까지 수행
export function guardOutput(text: string) {
  const sanitized = sanitizeOutput(text);
  return trimByPolicy(sanitized, LENGTH_POLICY_DEFAULT);
}
