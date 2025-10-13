// src/logic/bridge.ts — use Vercel proxy in PROD, direct OpenAI in DEV

export function toPrompt(action: {
  type:
    | 'open_model_trend'
    | 'open_model_ev'
    | 'open_network'
    | 'open_builder'
    | 'open_network_kind'
    | 'recommend_ev';
  payload?: any;
}) {
  switch (action.type) {
    case 'open_model_trend':
      return '인기모델 보여줘';
    case 'open_model_ev':
      return '전기차 추천해줘';
    case 'recommend_ev':
      return '전기차 추천해줘';
    case 'open_builder':
      return '내 차 만들기 시작하자';
    case 'open_network':
      return '근처 서비스센터';
    case 'open_network_kind':
      return `${action.payload?.kind || '서비스센터'} 찾기`;
    default:
      return '';
  }
}

export type LLMOpts = {
  model?: string;
  useMini?: boolean;
  stream?: boolean;
  maxOutputTokens?: number;
  timeoutMs?: number;
};

function redact(key?: string) {
  if (!key) return '(none)';
  return key.slice(0, 7) + '...' + key.slice(-4);
}

export async function callLLM(prompt: string, opts: LLMOpts = {}) {
  const IS_PROD = import.meta.env.PROD;

  // Decide backend endpoint
  const BACKEND =
    import.meta.env.VITE_BACKEND_CHAT
    || (IS_PROD ? '/api/chat' : 'https://api.openai.com/v1/chat/completions');

  // Models
  const MODEL_PRIMARY = import.meta.env.VITE_MODEL_PRIMARY ?? 'gpt-4o';
  const MODEL_MINI = import.meta.env.VITE_MODEL_MINI ?? 'gpt-4o-mini';
  const model = opts.model ?? (opts.useMini ? MODEL_MINI : MODEL_PRIMARY);

  // Runtime options
  const stream = opts.stream ?? (import.meta.env.VITE_STREAMING === 'true');
  const maxTokens = Number(
    opts.maxOutputTokens ?? import.meta.env.VITE_MAX_OUTPUT_TOKENS ?? 260
  );
  const timeoutMs = Number(
    opts.timeoutMs ?? import.meta.env.VITE_TIMEOUT_MS ?? 12000
  );

  // dev/StackBlitz only (Direct OpenAI)
  const apiKey = import.meta.env.VITE_OPENAI_API_KEY;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  // Only attach Authorization when calling OpenAI directly (dev). Never in prod.
  if (!BACKEND.startsWith('/')) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  // diag log (key는 마스킹)
  console.log('[LLM_CALL]', {
    model, stream, maxTokens, timeoutMs, key: redact(apiKey), backend: BACKEND
  });

  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());

  try {
    const res = await fetch(BACKEND, {
      method: 'POST',
      signal: ctrl.signal,
      // same-origin for server proxy; cors for direct OpenAI in dev
      mode: BACKEND.startsWith('/') ? 'same-origin' : 'cors',
      headers,
      body: JSON.stringify({
        model,
        stream,
        messages: [
          {
            role: 'system',
            content: [
              '당신은 현대자동차 고객 지원 챗봇입니다.',
              '한국어로 답하되 최대 5문장(가급적 2~3문장)으로 압축.',
              '불릿은 최대 4개, 근거가 없으면 추측 금지.',
              '말풍선 내 링크/각주 표기 금지(링크는 UI 버튼).',
            ].join(' ')
          },
          { role: 'user', content: prompt }
        ],
        max_tokens: maxTokens,
        temperature: 0.2
      })
    });

    const raw = await res.text();
    const t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const ms = t1 - t0;

    if (!res.ok) {
      console.error('[LLM_FAIL_HTTP]', res.status, raw);
      return { ok: false as const, error: `http ${res.status}: ${raw}` };
    }

    let data: any = {};
    try { data = JSON.parse(raw); } catch {}
    const text = data?.choices?.[0]?.message?.content ?? '';
    console.log('[LLM_OK]', { ms, textPreview: text.slice(0, 120) });
    return { ok: true as const, text, ms };
  } catch (e: any) {
    console.error('[LLM_FAIL_EX]', String(e));
    return { ok: false as const, error: String(e) };
  } finally {
    clearTimeout(to);
  }
}
