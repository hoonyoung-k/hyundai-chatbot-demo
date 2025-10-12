// src/main.tsx
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.merged.tsx'
import './index.css'
import './test/runBatch.r2';


ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)

// ──────────────────────────────────────────────────────────────
// Dev 전용 유틸 노출: __ask (단일 질문 실행) + __runBatch (일괄 회귀)
// ──────────────────────────────────────────────────────────────
if (import.meta.env.DEV && typeof window !== 'undefined') {
  // 1) __ask 노출 (router.runOnce)
  (async () => {
    try {
      const mod = await import('./logic/router'); // 동적 import로 안전
      const runOnce = (mod as any).runOnce;
      if (typeof runOnce === 'function') {
        (window as any).__ask = runOnce;
        console.log('[DEV] __ask ready');
      } else {
        console.warn('[DEV] runOnce not found in ./logic/router');
      }
    } catch (e) {
      console.warn('[DEV] failed to expose __ask:', e);
    }
  })();

  // 2) __runBatch 노출 (브라우저 러너)
  (async () => {
    try {
      // 파일명/경로 정확히: src/test/runBatch.browser.ts
      const m = await import('./test/runBatch.browser');
      if (typeof (m as any).runBatchBrowser === 'function') {
        (window as any).__runBatch = (m as any).runBatchBrowser;
        console.log('[DEV] __runBatch ready');
      } else {
        console.warn('[DEV] runBatchBrowser not found in ./test/runBatch.browser');
      }
    } catch (e) {
      console.warn('[DEV] failed to expose __runBatch:', e);
    }
  })();
}

// (선택) 타입 경고 없애기
declare global {
  interface Window {
    __ask?: (q: string) => Promise<any>;
    __runBatch?: () => Promise<void>;
  }
}

