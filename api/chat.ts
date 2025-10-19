// /api/chat.ts — Vercel Node.js Function (non-streaming proxy)

import type { VercelRequest, VercelResponse } from '@vercel/node';

export const config = {
  runtime: 'nodejs20',
  maxDuration: 20,
  regions: ['icn1', 'hnd1', 'iad1'], // 선택
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method Not Allowed' });
      return;
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      res.status(500).json({ error: 'OPENAI_API_KEY missing' });
      return;
    }

    // 클라이언트에서 보낸 페이로드 받아오기 (기본값 포함)
    const {
      model = 'gpt-4o-mini',
      stream = false, // 현재는 비스트리밍 프록시
      messages = [],
      max_tokens = 350,
      temperature = 0.2,
    } = (req.body ?? {}) as {
      model?: string;
      stream?: boolean;
      messages?: any[];
      max_tokens?: number;
      temperature?: number;
    };

    const controller = new AbortController();
    const timeoutMs = Number(process.env.REQUEST_TIMEOUT_MS || 20000);
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        stream,
        messages,
        max_tokens,
        temperature,
      }),
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));

    if (!r.ok) {
      const errText = await r.text().catch(() => '');
      res.status(r.status).json({ ok: false, error: `openai ${r.status}`, detail: errText });
      return;
    }

    const json = await r.json();
    res.status(200).json({ ok: true, ...json });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message || 'server_error' });
  }
}
