// src/logic/logger.ts
export type LogEvent = {
  user_id?: string;
  intent?: string;
  route?: 'rule' | 'rag' | 'fallback';
  retr_k?: number;
  retr_ms?: number;
  ctx_tokens?: number;
  llm_ms?: number;
  ttfb_ms?: number;
  status?: 'pass' | 'fail';
  fail_reason?: 'RETR_FAIL' | 'CTX_LOSS' | 'PROMPT_FAIL' | 'SAFETY_REDIRECT' | 'OTHER';
  at?: string; // ISO timestamp
};

const buffer: LogEvent[] = [];

export function logEvent(ev: LogEvent) {
  const payload = { at: new Date().toISOString(), ...ev };
  console.log('[LOG]', payload);   // 일단 콘솔에 찍기
  buffer.push(payload);            // 메모리에 저장
}

export function getLogs() {
  return buffer;
}

export function clearLogs() {
  buffer.length = 0;
}
