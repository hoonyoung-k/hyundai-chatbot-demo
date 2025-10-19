// /api/chat.ts — Vercel **Node** Function proxy for OpenAI
const controller = new AbortController();
const timeoutMs = Number(getEnv('REQUEST_TIMEOUT_MS') || 20000);
const t = setTimeout(() => controller.abort(), timeoutMs);

const r = await fetch('https://api.openai.com/v1/chat/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
  body: JSON.stringify({ model, stream, messages, max_tokens, temperature }),
  signal: controller.signal,
}).finally(() => clearTimeout(t));


// 환경변수 안전 접근
function getEnv(name: string): string {
  const val =
    (globalThis as any)?.process?.env?.[name] ??
    (globalThis as any)?.ENV?.[name] ??
    '';
  return typeof val === 'string' ? val : String(val ?? '');
}

export default async function handler(req: Request): Promise<Response> {
  try {
    const body = await req.json();
    const {
      model = 'gpt-4-turbo',   // 기본값 지정
      stream = false,
      messages = [],
      max_tokens = 400,
      temperature = 0.7,
    } = body ?? {};

    const apiKey = getEnv('OPENAI_API_KEY');
    if (!apiKey) {
      return new Response(JSON.stringify({ error: 'Missing OPENAI_API_KEY on server' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    }

    const controller = new AbortController();
    const timeoutMs = Number(getEnv('REQUEST_TIMEOUT_MS=25000') || 20000); // 20s 디폴트
    const t = setTimeout(() => controller.abort(), timeoutMs);

    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        stream,
        messages,
        max_tokens,
        temperature,
      }),
      signal: controller.signal,
    }).finally(() => clearTimeout(t));


    // Stream or JSON passthrough
    return new Response(r.body, {
      status: r.status,
      headers: {
        'Content-Type': r.headers.get('content-type') || 'application/json',
        'Cache-Control': 'no-store',
      },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({
      error: e?.message || String(e),
      name: e?.name,
      stack: e?.stack,
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }
}
