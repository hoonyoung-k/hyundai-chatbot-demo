import React, { createContext, useContext, useMemo, useState } from 'react';
import { handleUserText, type BotReply } from '../logic/router';

/** 채팅 히스토리: 텍스트 or 리치 페이로드 */
export type ChatEntry =
  | { type: 'text'; from: 'user' | 'bot'; text: string }
  | { type: 'rich'; from: 'bot'; payload: BotReply };

type ChatCtx = {
  history: ChatEntry[];
  busy: boolean;
  send: (msg: string) => Promise<void>;
  reset: () => void;
};

const Ctx = createContext<ChatCtx | null>(null);

export function ChatProvider({ children }: { children: React.ReactNode }) {
  const [history, setHistory] = useState<ChatEntry[]>([]);
  const [busy, setBusy] = useState(false);

  async function send(msg: string) {
    const m = (msg || '').trim();
    if (!m) return;

    setBusy(true);
    setHistory((h) => [...h, { type: 'text', from: 'user', text: m }]);

    // router가 async 이므로 반드시 await
    const reply = await handleUserText(m);

    // 1) 봇의 텍스트 메시지들 출력
    for (const line of reply.messages) {
      setHistory((h) => [...h, { type: 'text', from: 'bot', text: line }]);
      // 타자감 살짝
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 60));
    }

    // 2) 칩/카드/스티키 CTA가 있다면 리치 블록 한 번에 출력
    if ((reply.cards?.length ?? 0) > 0 || (reply.chips?.length ?? 0) > 0 || reply.sticky_cta) {
      setHistory((h) => [...h, { type: 'rich', from: 'bot', payload: reply }]);
    }

    setBusy(false);
  }

  const api: ChatCtx = useMemo(
    () => ({
      history,
      busy,
      send,
      reset: () => setHistory([]),
    }),
    [history, busy]
  );

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

export function useChat() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useChat must be used within <ChatProvider>');
  return v;
}
