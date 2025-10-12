// src/logic/bridge.ts
export function toPrompt(action: {
  type:
    | 'open_model_trend'
    | 'open_model_ev'
    | 'open_network'
    | 'open_builder'
    //| 'open_network_kind';
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
      // 라우터가 확실히 잡도록 미세 토큰 동봉 (원하면 빼도 됨)
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
  model?: string; // 강제 지정 시 사용 (옵션)
  useMini?: boolean; // true면 MINI 모델 사용
  stream?: boolean;
  maxOutputTokens?: number;
  timeoutMs?: number;
};

function redact(key?: string) {
  if (!key) return '(none)';
  return key.slice(0, 7) + '...' + key.slice(-4);
}

export async function callLLM(prompt: string, opts: LLMOpts = {}) {
  // ✅ .env
  // VITE_MODEL_PRIMARY=gpt-4o
  // VITE_MODEL_MINI=gpt-4o-mini
  const MODEL_PRIMARY = import.meta.env.VITE_MODEL_PRIMARY ?? 'gpt-4o';
  const MODEL_MINI = import.meta.env.VITE_MODEL_MINI ?? 'gpt-4o-mini';

  // 선택 로직: 명시 model > useMini > 기본
  const model = opts.model ?? (opts.useMini ? MODEL_MINI : MODEL_PRIMARY);

  const stream = opts.stream ?? import.meta.env.VITE_STREAMING === 'true';
  // 🔽 기본 상한을 260으로 낮춥니다(필요 시 .env로 덮어쓰기 가능)
  const maxTokens = Number(
    opts.maxOutputTokens ?? import.meta.env.VITE_MAX_OUTPUT_TOKENS ?? 260
  );
  const timeoutMs = Number(
    opts.timeoutMs ?? import.meta.env.VITE_TIMEOUT_MS ?? 12000
  );
  const apiKey = import.meta.env.VITE_OPENAI_API_KEY;

  console.log('[LLM_CALL]', {
    model,
    stream,
    maxTokens,
    timeoutMs,
    key: redact(apiKey),
  });

  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = performance.now();

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        stream,
        messages: [
          {
            role: 'system',
            // 🔑 말풍선 정책 반영: 인라인 링크·인용 금지 + 5문장 규칙
            content: [
              '당신은 현대자동차 고객 지원 챗봇입니다.',
              '한국어로 답하되, **최대 5문장** 이내로 답하세요. 가능하면 2~3문장으로 압축하세요.',
              '불릿은 최대 4개까지만 사용하세요(문장 수에 포함).',
              '컨텍스트에 없는 정보는 추측하지 말고 "FAQ 범위 밖 질문입니다."라고 답하세요.',
              '말풍선에 인라인 링크·각주·[출처 1] 같은 표기는 넣지 마세요. 링크는 UI 버튼으로만 제공합니다.',
            ].join(' '),
          },
          { role: 'user', content: prompt },
        ],
        max_tokens: maxTokens,
        temperature: 0.2,
      }),
    });

    const raw = await res.text();
    const ms = performance.now() - t0;

    if (!res.ok) {
      console.error('[LLM_FAIL_HTTP]', res.status, raw);
      return { ok: false as const, error: `http ${res.status}: ${raw}` };
    }

    let data: any;
    try {
      data = JSON.parse(raw);
    } catch {
      data = {};
    }

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
