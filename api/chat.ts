// /api/chat.ts — Vercel Edge Function proxy for OpenAI (no Node typings required)
export const config = { runtime: 'edge' };

function getEnv(name: string): string {
  // Avoid TS "process" typing by accessing via globalThis
  const val =
    (globalThis as any)?.process?.env?.[name] ??
    (globalThis as any)?.ENV?.[name] ?? // fallback just in case
    '';
  return typeof val === 'string' ? val : String(val ?? '');
}

export default async function handler(req: Request): Promise<Response> {
  try {
    const { model, stream, messages, max_tokens, temperature } = await req.json();

    const apiKey = getEnv('OPENAI_API_KEY');
    if (!apiKey) {
      return new Response(JSON.stringify({ error: 'Missing OPENAI_API_KEY on server' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    }

    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // IMPORTANT: never expose the key to the browser; server-side only
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        stream,
        messages,
        max_tokens,
        temperature,
      }),
    });

    // Stream or JSON passthrough
    return new Response(r.body, {
      status: r.status,
      headers: {
        'Content-Type': r.headers.get('content-type') || 'application/json',
        'Cache-Control': 'no-store',
      },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: String(e?.message || e) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }
}
