// /api/chat.ts — Vercel Edge Function proxy for OpenAI
export const config = { runtime: 'edge' };

export default async function handler(req: Request) {
  try {
    const { model, stream, messages, max_tokens, temperature } = await req.json();

    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // IMPORTANT: never expose the key to the browser; use server env only
        Authorization: `Bearer ${process.env.OPENAI_API_KEY || ''}`,
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
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }
}
