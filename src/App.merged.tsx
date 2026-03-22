// src/App.merged.tsx
import ReactDOM from 'react-dom';
import { useMemo, useState, useRef, useEffect, useLayoutEffect } from 'react';

import { ChatProvider, useChat } from './state/chat';
import { toPrompt } from './logic/bridge';
import EvInfoCard from './ui/components/EvInfoCard';
import type { BotReply } from './logic/router';

import centers from './assets/centers.json';
import { withCoordsFromUrl, getGeoOnce } from './logic/geo';





// ✅ ev_ok 표준화: evCapable / types / 문자열 형태까지 모두 흡수
const rowsBase = withCoordsFromUrl(centers as any[]).map((r: any) => {
  const evFromTypes = Array.isArray(r.types) && r.types.some((t: any) => /ev/i.test(String(t)));
  const evFromCap   = r.evCapable === true || r.ev_capable === true;
  const evFromStr   = typeof r.ev_ok === 'string' && /true|ev|가능/i.test(r.ev_ok);

  return {
    ...r,
    ev_ok: typeof r.ev_ok === 'boolean' ? r.ev_ok : (evFromTypes || evFromCap || evFromStr) || false,
  };
});

// 파일 상단 import 근처에 아무데나 추가해도 됩니다.
const HomeIcon = ({ size = 18 }: { size?: number }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
    <path
      d="M3 10.5L12 3l9 7.5V20a1 1 0 0 1-1 1h-5.5a1 1 0 0 1-1-1v-4.5h-4V20a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-9.5z"
      fill="currentColor"
    />
  </svg>
);

// 🔽 feature flag 선언
const BUILDER_ENABLED = false;

/* --------------------------------------
   인라인 채팅 렌더러 (입력창은 DockInput 하나만 사용)
---------------------------------------*/
// App.merged.tsx — 기존 Chips 를 아래로 교체
function Chips({ chips, onPick }: { chips: string[]; onPick: (c: string) => void }) {
  if (!chips?.length) return null;

  const handleClick = (label: string) => {
    const t = (label || "").trim();
    const norm = t.replace(/\s+/g, "");

    if (t === "혜택") {
      // 모델 허브를 '혜택 필터 켠 상태'로 바로 오픈
      window.dispatchEvent(new CustomEvent("open-model-hub", { detail: { tab: "ALL", promoOnly: true } }));
      return; // ← 채팅으로 보내지 않음
    }
    if (norm === "자주묻는질문") {
      // FAQ 패널 바로 오픈
      window.dispatchEvent(new CustomEvent("open-faq"));
      return; // ← 채팅으로 보내지 않음
    }
    if (t === "처음으로") {
      onPick("처음"); // 홈 라우팅은 텍스트로 처리
      return;
    }

    // 기본: 기존 동작 유지
    onPick(t);
  };

  return (
    <div className="flex flex-wrap gap-2">
      {chips.map((c, i) => (
        <button key={i} className="hd-chip" onClick={() => handleClick(c)}>
          {c}
        </button>
      ))}
    </div>
  );
}

// 지점명(주소) → Google Maps 검색 URL
function toGmapsUrl(c: { name?: string; address?: string; lat?: number; lng?: number }) {
  const qName = (c.name || '').trim();
  const qAddr = (c.address || '').trim();
  if (qName || qAddr) {
    // 베스트: 지점명 + 주소로 검색(지점 카드가 열림)
    const q = encodeURIComponent([qName, qAddr].filter(Boolean).join(' '));
    return `https://www.google.com/maps/search/?api=1&query=${q}`;
  }
  // 폴백: 좌표
  if (typeof c.lat === 'number' && typeof c.lng === 'number') {
    return `https://www.google.com/maps/search/?api=1&query=${c.lat},${c.lng}`;
  }
  return 'https://www.google.com/maps'; // 최후의 폴백
}



function VehicleCard({
  v,
  onAction,
}: {
  v: BotReply['cards'][number] & { type: 'vehicle' };
  onAction: (a: string, id?: string) => void;
}) {
  return (
    <div className="hd-card p-4 space-y-2">
      <div className="flex items-center justify-between">
        <div className="card-title">{v.title}</div>
        <div className="flex gap-1">
          {v.badges?.map((b, i) => (
            <span key={i} className={`badge ${b === '혜택' ? 'badge-amber' : ''}`}>
              {b}
            </span>
          ))}
        </div>
      </div>
      <div className="card-sub">{v.spec?.segment ?? '차량'} · 주행거리 {v.spec?.range_km ?? '-'}km</div>
      <div className="price">{v.price_from ? `₩${v.price_from.toLocaleString()}부터` : '-'}</div>
      <div className="flex gap-2 pt-1">
        {v.cta?.map((c, i) => (
          <button
            key={i}
            className={`hd-btn ${i === 1 ? 'hd-btn--primary' : ''}`}
            onClick={() => onAction(c.action, c.id)}
          >
            {c.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function CenterCard({
  c,
  onAction,
}: {
  c: BotReply['cards'][number] & { type: 'center' };
  onAction: (a: string, id?: string) => void;
}) {
  return (
    <div className="hd-card p-4 space-y-1">
      <div className="card-title">{c.title}</div>
      <div className="card-sub">
        {c.kind} · {c.distance_km}km · EV {c.ev_ok ? '가능' : '불가'}
      </div>
      <div className="flex gap-2 pt-2">
        {c.cta?.map((b, i) => (
          <button
            key={i}
            className={`hd-btn ${b.label === '예약' ? 'hd-btn--primary' : ''}`}
            onClick={() => onAction(b.action, b.id)}
          >
            {b.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function HomeInline({
  onOpenModel,
  onGoBuilder,
  onOpenNetwork,
  onOpenFaq,                           // ★ 추가
}: {
  onOpenModel?: (opts?: any) => void;
  onGoBuilder?: () => void;
  onOpenNetwork?: (preset?: string | null) => void;
  onOpenFaq?: () => void;              // ★ 추가
}) {
  const Tile = ({ title, desc, btn, onClick }: any) => (
    <div className="rounded-2xl bg-white border border-slate-200 p-4 shadow-sm">
      <div className="text-slate-900 font-medium">{title}</div>
      <div className="text-slate-500 text-sm mt-1">{desc}</div>
      <div className="mt-3">
        <button onClick={onClick} className="rounded-xl bg-[#0b1b2b] text-white text-sm px-3 py-2">
          {btn}
        </button>
      </div>
    </div>
  );

  const { send /* 또는 send */ } = useChat();

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <Tile
          title="인기모델 보기"
          desc="데이터 기반 TOP"
          btn="열기"
          onClick={() => onOpenModel?.({ preset: 'trend' })}
        />
        <Tile
          title="내 차 만들기"
          desc="옵션 구성/견적"
          btn="시작"
          onClick={() => {
            // 프로젝트에 따라 이름이 다르면 sendUser → send 로 바꿔줘
            send('내 차 만들기');
          }}
          //onClick={() => onGoBuilder?.()}
        />
        <Tile
          title="서비스센터 찾기"
          desc="가까운 순 표시"
          btn="열기"
          onClick={() => onOpenNetwork?.(null)}
        />
        <Tile
          title="전기차 정보"
          desc="충전/보조금/유지비"
          btn="보기"
          //onClick={() => onOpenModel?.({ preset: 'ev' })}
          onClick={() => send(toPrompt({ type: 'recommend_ev' }))}
        />
      </div>

      {/* 카테고리 칩 (원하시면 유지/삭제) */}
      <div className="mt-2 flex flex-wrap gap-2">
        <button
          className="hd-chip"
          onClick={() => onOpenModel?.({ preset: 'trend', promo: true })}
        >
          혜택
        </button>

        {/* ★ 새로 추가: 드라이빙 라운지 프리셋으로 네트워크 허브 오픈 */}
        <button
          className="hd-chip"
          onClick={() => onOpenNetwork?.('드라이빙 라운지')}
        >
          시승/예약
        </button>
        
        <button
          className="hd-chip"
          onClick={() => onOpenFaq?.()}
        >
          자주 묻는 질문
        </button>
      </div>
    </div>
  );
}


function RichBlock({
  payload,
  onPrompt,
  onOpenModelHub,
  onOpenModel,
  onOpenNetwork,
  onGoBuilder,
  onOpenFaq,
}: {
  payload: BotReply;
  onPrompt: (p: string) => void;
  onOpenModelHub?: (tab: 'EV' | 'ALL' | 'HEV') => void;
  onOpenNetwork?: (preset?: string | null) => void;
  onOpenModel?: (opts?: any) => void;
  onGoBuilder?: () => void;
  onOpenFaq?: () => void;
}) {
  const onAction = (action: string, id?: string) => {
    if (action.startsWith('builder')) onPrompt('내 차 만들기 시작하자');
    else if (action.startsWith('lead')) onPrompt('구매 상담 연결해줘');
    else if (action.startsWith('compare')) onPrompt('이 모델 비교에 추가');
    else if (action.startsWith('map')) onPrompt('지도 열어줘');
    else if (action.startsWith('tel')) onPrompt('전화 연결해줘');
    else if (action.startsWith('booking')) onPrompt('시승 예약하고 싶어');

    // 🔗 외부 링크/허브/기타 CTA 처리
    else if (action.startsWith('url')) {
      if (id) window.open(id, '_blank', 'noopener,noreferrer');
    } else if (action.startsWith('price')) {
      window.open('https://www.hyundai.com/kr/ko/e/vehicles/catalog-price-download', '_blank', 'noopener,noreferrer');
    } else if (action.startsWith('warranty')) {
      window.open('https://www.hyundai.com/kr/ko/purchase-event/policy-Information/warranty/normal-period', '_blank', 'noopener,noreferrer');
    } else if (action.startsWith('charging')) {
      window.open('https://www.ev.or.kr/nportal/buySupprt/initSubsidy', '_blank', 'noopener,noreferrer');
    } else if (action === 'network:testdrive') {
      window.dispatchEvent(
        new CustomEvent("open-network", { detail: { tab: "드라이빙 라운지" } })
      );
      return;
    } else if (action === 'network:service') {
      window.dispatchEvent(
        new CustomEvent("open-network", { detail: { tab: "서비스센터" } })
      );
      return;
    } else if (action === 'hub:promo') {
      // ✅ 혜택 전용: 프로모션 필터 ON으로 모델 허브 열기
      window.dispatchEvent(new CustomEvent("open-model-hub", { detail: { tab: "ALL", promoOnly: true } }));
      return;
    } else if (action.startsWith('hub')) {
      // 일반 허브 오픈 (탭만)
      const tab = (id as any) || 'ALL';
      onOpenModelHub?.(tab);
    } else if (action === 'faq:open') {
      // ✅ FAQ 바텀시트 열기 (메인 "자주 묻는 질문" 칩과 동일 동작)
      window.dispatchEvent(new CustomEvent("open-faq", { detail: { source: "cta" } }));
      return;
    }
    
  };

  return (
    <div className="space-y-3">
      {/* ✅ 1) CTA 버튼을 최상단에 렌더링 */}
      {payload.sticky_cta && (
        <div className="pt-1">
          <button
            className="hd-btn hd-btn--primary w-full"
            onClick={() => onAction(payload.sticky_cta!.action, payload.sticky_cta!.id)}
          >
            {payload.sticky_cta!.label}
          </button>
        </div>
      )}

      {/* ✅ 2) chips는 CTA 아래에 표기 */}
      {payload.chips && <Chips chips={payload.chips} onPick={onPrompt} />}

      {/* ✅ 3) 카드 렌더링 */}
      {payload.cards?.map((it, idx) => {
        if (it.type === 'vehicle') return <VehicleCard key={idx} v={it as any} onAction={onAction} />;
        if (it.type === 'center')  return <CenterCard  key={idx} c={it as any} onAction={onAction} />;
        if (it.type === 'ev_recommend') {
          return (
            <EvInfoCard
              key={idx}
              // 카드 하단 CTA: 모델 허브(EV 탭) 열기
              onOpenHub={() => onAction('hub:open', 'EV')}
            />
          );
        }
        if ((it as any).type === 'home') {
          return (
            <div key={idx} className="hd-card p-4">
              <HomeInline
                onOpenModel={onOpenModel}
                onOpenNetwork={onOpenNetwork}
                onGoBuilder={onGoBuilder}
                onOpenFaq={onOpenFaq}
              />
            </div>
          );
        }
        return null;
      })}
    </div>
  );
}


function InlineChat({
  onOpenNetwork,
  onOpenModel,     // ★ 추가
  onGoBuilder,     // ★ 추가
  onOpenFaq,                    // ★ 추가
  networkOpen = false,
  currentPreset = null, // ★ 추가
  onOpenModelHub,
}: {
  onOpenNetwork?: (preset?: string | null) => void;
  onOpenModel?: (opts?: any) => void; // ★ 추가
  onGoBuilder?: () => void;           // ★ 추가
  onOpenFaq?: () => void;       // ★ 추가
  networkOpen?: boolean;
  currentPreset?: string | null; // ★ 추가
  onOpenModelHub?: (tab: 'EV' | 'ALL' | 'HEV') => void;
}) {
  const { history, send, busy } = useChat();
  const bottomRef = useRef<HTMLDivElement | null>(null);

  // 이미 오픈을 트리거한 센터카드 인덱스/프리셋 기억
  const lastOpenedIndexRef = useRef<number>(-1);
  const lastPresetRef = useRef<string | null>(null);

  // 닫은 직후 자동 오픈 억제 (레이스 방지)
  const prevOpenRef = useRef(networkOpen);
  const suppressUntilRef = useRef(0);
  useEffect(() => {
    if (prevOpenRef.current && !networkOpen) {
      suppressUntilRef.current = Date.now() + 400; // 0.4s
    }
    prevOpenRef.current = networkOpen;
  }, [networkOpen]);

  const hasCenterCards = (m: any) =>
    m && m.type !== 'text' && m?.payload?.cards?.some((c: any) => c?.type === 'center');

  const isFallbackText = (t: string = '') =>
    /(죄송|학습 중|골라보실래요|도와드릴 수|모르겠|이해하지 못|다시 말씀|무엇을 도와)/.test(t);

  const inferNetworkPreset = (t: string = ''): string | null => {
    if (/(지점|대리점)/.test(t)) return '지점/대리점';
    if (/(라운지|드라이빙)/.test(t)) return '드라이빙 라운지';
    if (/(서비스센터|센터)/.test(t)) return '서비스센터';
    return null;
  };

  const presetForOpen = (idx: number): string | null => {
    const cur = history[idx];
    if (!hasCenterCards(cur)) return null;

    // 직전 사용자 발화
    let prevUserText = '';
    for (let i = idx - 1; i >= 0; i--) {
      if (history[i]?.type === 'text' && history[i]?.from === 'user') {
        prevUserText = history[i].text || '';
        break;
      }
    }
    const preset = inferNetworkPreset(prevUserText);
    if (!preset) return null;

    // 사용자 발화 이후~현재 사이 봇 텍스트 중 폴백이 있으면 열지 않음
    for (let i = idx - 1; i >= 0; i--) {
      const m = history[i];
      if (m?.type === 'text' && m?.from === 'user') break;
      if (m?.type === 'text' && m?.from !== 'user' && isFallbackText(m.text || '')) {
        return null;
      }
    }
    return preset;
  };

  // ★ 외부에서 시트가 열렸을 때 동기화 (의도/인덱스)
  useEffect(() => {
    if (!networkOpen) return;
    if (currentPreset) lastPresetRef.current = currentPreset;

    for (let i = history.length - 1; i >= 0; i--) {
      if (hasCenterCards(history[i])) {
        if (i > lastOpenedIndexRef.current) lastOpenedIndexRef.current = i;
        break;
      }
    }
  }, [networkOpen, currentPreset, history]);

  // ✅ InlineChat 안의 renderList useMemo 전체 교체
const renderList = useMemo(() => {
  const out: any[] = [];
  const now = Date.now();

  // 🔑 가장 마지막(최신) 센터카드 인덱스만 자동 오픈 대상으로 사용
  let latestCenterIdx = -1;
  for (let j = history.length - 1; j >= 0; j--) {
    if (hasCenterCards(history[j])) { latestCenterIdx = j; break; }
  }

  for (let i = 0; i < history.length; i++) {
    const cur = history[i];
    const nxt = history[i + 1];

    const nextPreset = hasCenterCards(nxt) ? presetForOpen(i + 1) : null;
    if (cur.type === 'text' && nextPreset && (i + 1) === latestCenterIdx) {
      // 최신 센터카드 직전의 안내문은 숨김
      continue;
    }

    if (hasCenterCards(cur)) {
      // ✅ 최신 센터카드일 때만 자동 오픈 트리거
      const isLatest = i === latestCenterIdx;

      if (isLatest) {
        const preset = presetForOpen(i);
        if (
          preset &&
          onOpenNetwork &&
          !networkOpen &&                 // 열려있으면 호출 금지
          now >= suppressUntilRef.current // 닫은 직후 억제
        ) {
          const isNewCard = i > lastOpenedIndexRef.current;
          const presetChanged = preset !== lastPresetRef.current;
          if (isNewCard || presetChanged) {
            lastOpenedIndexRef.current = i;
            lastPresetRef.current = preset;
            onOpenNetwork(preset);
          }
        }

        // 최신 카드에만 안내+칩 노출 (이전 카드들은 아무것도 추가 안함)
        out.push({
          type: 'text',
          from: 'bot',
          text: '원하는 네트워크를 찾으셨나요? 도움이 필요한 항목을 언제든지 말씀 주세요.',
        });
        out.push({ type: 'rich', payload: { chips: ['전기차 추천', '근처 서비스센터', '내 차 만들기'] } });
      }

      // 센터카드 자체는 계속 숨김
      continue;
    }

    out.push(cur);
  }

  return out;
}, [history, onOpenNetwork, networkOpen]);


  // 자동 스크롤(부드럽게): 하단 근처면 smooth, 아니면 즉시
  useEffect(() => {
      const el = document.scrollingElement || document.documentElement;
      const threshold = 120; // 하단 근처로 간주할 여유 픽셀
      const nearBottom =
        el.scrollTop + el.clientHeight >= el.scrollHeight - threshold;
  
      const jumpToBottom = () => { el.scrollTop = el.scrollHeight; };
      const smoothToBottom = () =>
        el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  
      // 큰 점프(한 화면 이상 증가)는 즉시, 그 외엔 스무스
      const prevH = (jumpToBottom as any)._prevH ?? el.scrollHeight;
      const grew = el.scrollHeight - prevH;
      const bigJump = grew > el.clientHeight * 0.75;
  
      if (nearBottom) {
        // 레이아웃 커밋 후 스무스 스크롤
        requestAnimationFrame(() => {
          if (bigJump) {
            jumpToBottom();
          } else {
            smoothToBottom();
          }
          // 이미지/폰트 로드로 높이 추가 변동 시 한 번 더 보정
          setTimeout(() => smoothToBottom(), 80);
        });
      } else {
        // 사용자가 위로 올려본 상태면 건드리지 않음(대화 읽기 방해 X)
      }
  
      (jumpToBottom as any)._prevH = el.scrollHeight;
    }, [renderList.length, busy]);

  return (
    <div className="space-y-3">
      {renderList.map((m: any, i: number) => {
         if (m.type === 'text') {
          // ⭐ 최근 사용자 발화를 원본 history에서 직접 확인
          const lastUserSaidPopular = (() => {
            for (let j = history.length - 1; j >= 0; j--) {
              const h = history[j];
              if (h?.type === 'text' && h?.from === 'user') {
                return /(인기모델|인기 모델|모델 허브|popular)/i.test((h.text || '').trim());
              }
            }
            return false;
          })();

          let text: string = (m.text || '').trim();
          const isBot = m.from !== 'user';
          const isFallback = /(죄송|학습 중|골라보실래요)/.test(text);

          // 폴백 문구 + 직전 사용자 의도가 '인기모델'이면 워싱
          if (isBot && isFallback && lastUserSaidPopular) {
            text = '인기 모델은 상단의 “모델 허브”에서 바로 보실 수 있어요!';
          }

          return (
            <div key={i} className={`flex ${m.from === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`${m.from === 'user' ? 'bg-blue-600 text-white' : 'bg-gray-100'} rounded-2xl px-3 py-2 max-w-[80%]`}>
                {text}  {/* ← 여기! 가공된 text로 렌더 */}
              </div>
            </div>
          );
        }
       // return <RichBlock key={i} payload={m.payload} onPrompt={(p) => send(p)} />;
       return (
           <RichBlock
              key={i}
              payload={m.payload}
              onPrompt={(p) => send(p)}
              onOpenModelHub={onOpenModelHub}
              onOpenModel={onOpenModel}       // ★ 추가
              onOpenNetwork={onOpenNetwork}   // ★ 추가
              onGoBuilder={onGoBuilder}       // ★ 추가
              onOpenFaq={onOpenFaq}        // ★ 추가
           />
          );
      })}
      <div ref={bottomRef} />
    </div>
  );
}

/* --------------------------------------
   데모용 데이터/화면들
---------------------------------------*/
const MODELS = [
  { id: 'ioniq5', name: '아이오닉 5', type: 'EV', body: 'SUV', priceFrom: 52000000, range: 303, popular: true, promo: true,   
    promoDiscountPct: 10,                                   // ★ 할인율(%)
    promoEndsAt: '2026-05-21T23:59:59+09:00'               // ★ 혜택 종료(약 60일 후, 서울 TZ)
  },
  { id: 'kona-ev',  name: '코나 일렉트릭',  type: 'EV',  body: 'SUV',       priceFrom: 42000000, range: 410, popular: true },
  { id: 'ev6',      name: 'EV6',            type: 'EV',  body: 'Crossover', priceFrom: 55000000, range: 475 },

  // ===== 추가 EV 모델들 =====
  { id: 'ioniq6', name: '아이오닉 6', type: 'EV', body: 'Sedan',
    priceFrom: 56000000, range: 524, popular: true, promo: true,
    promoDiscountPct: 8, promoEndsAt: '2026-06-20T23:59:59+09:00'
  },
  { id: 'ioniq5n', name: '아이오닉 5 N', type: 'EV', body: 'SUV',
    priceFrom: 87000000, range: 450, popular: false, promo: false
  },
  { id: 'kona-ev-long', name: '코나 일렉트릭 롱레인지', type: 'EV', body: 'SUV',
    priceFrom: 45500000, range: 490, popular: true, promo: false,
  },
  { id: 'casper-ev', name: '캐스퍼 일렉트릭', type: 'EV', body: 'Compact',
    priceFrom: 29800000, range: 315, popular: true, promo: false,
  },

  // ===== 기존 HEV/ICE =====
  { id: 'santafe-hev', name: '싼타페 하이브리드', type: 'HEV', body: 'SUV', priceFrom: 37740000, mpg: 30.6, popular: true },
  { id: 'palisade',    name: '팰리세이드',        type: 'ICE', body: 'SUV', priceFrom: 52000000, popular: false,
    promo: true,
    promoDiscountPct: 10,
    promoEndsAt: '2026-09-21T23:59:59+09:00',
  },
  { id: 'avante',      name: '아반떼',            type: 'ICE', body: 'Sedan', priceFrom: 21000000, popular: true,  promo: false,
  },

  // ===== 모델 허브 추가 차량 =====
  { id: 'sonata', name: '쏘나타', type: 'ICE', body: 'Sedan', priceFrom: 29920000, popular: true, promo: false },
  { id: 'grandeur', name: '그랜저', type: 'ICE', body: 'Sedan', priceFrom: 37170000, popular: true, promo: false },
  { id: 'tucson', name: '투싼', type: 'ICE', body: 'SUV', priceFrom: 27730000, popular: true, promo: false },
  { id: 'staria', name: '스타리아', type: 'ICE', body: 'MPV', priceFrom: 36330000, popular: false, promo: false },
  { id: 'nexo', name: '넥쏘', type: 'ICE', body: 'SUV', priceFrom: 75000000, popular: false, promo: false },
];

const LOCATIONS = [
  { id: 1, kind: '서비스센터', name: '하이테크센터 강남', distanceKm: 2.1, ev: true },
  { id: 2, kind: '드라이빙 라운지', name: '드라이빙 라운지 양재', distanceKm: 5.3, ev: true },
  { id: 3, kind: '지점/대리점', name: '현대자동차 분당점', distanceKm: 6.2, ev: false },
  { id: 4, kind: '서비스센터', name: '블루핸즈 수원망포', distanceKm: 7.8, ev: true },
];
const formatPrice = (n: number) => `₩${n.toLocaleString()}`;
// KRW 포맷
const formatKRW = (n?: number) => (typeof n === 'number' ? `₩${n.toLocaleString()}` : '-');

// 프로모션 존재 여부
const hasPromo = (m: any) =>
  !!m?.promo && (typeof m.promoDiscountPct === 'number' || typeof m.promoDiscountAmount === 'number');

// 할인 금액 계산 (우선순위: amount > pct)
const getDiscountAmount = (m: any) => {
  if (typeof m.promoDiscountAmount === 'number') return m.promoDiscountAmount;
  if (typeof m.promoDiscountPct === 'number' && typeof m.priceFrom === 'number') {
    return Math.round(m.priceFrom * (m.promoDiscountPct / 100));
  }
  return 0;
};

// 할인 라벨 (예: "10% 할인")
const discountLabel = (m: any) =>
  (typeof m.promoDiscountPct === 'number' ? `${m.promoDiscountPct}% 할인` : '할인');


// 금액을 "만원" 단위로 짧게: 5,200,000 → "520만원", 550,000 → "55만원"
function formatWonShort(n: number) {
  const man = Math.round(n / 10000); // 깔끔하게 반올림
  return `${man.toLocaleString()}만원`;
}

// 할인액/혜택가 계산
function calcDiscount(priceFrom?: number, pct?: number, amount?: number) {
  if (!priceFrom) return null;
  const discountAmt =
    typeof amount === 'number'
      ? amount
      : typeof pct === 'number'
      ? Math.round(priceFrom * (pct / 100))
      : 0;
  const finalPrice = Math.max(0, priceFrom - discountAmt);
  const pctText =
    typeof pct === 'number' ? `${pct}% ↓` : undefined;
  return { discountAmt, finalPrice, pctText };
}


// 실시간 카운트다운: "12일 04:25:13" (0일이면 일 생략)
function formatRemaining(endMs: number, nowMs: number) {
  const diff = Math.max(0, Math.floor((endMs - nowMs) / 1000));
  const d = Math.floor(diff / 86400);
  const h = Math.floor((diff % 86400) / 3600);
  const m = Math.floor((diff % 3600) / 60);
  const s = diff % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return d > 0 ? `${d}일 ${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(h)}:${pad(m)}:${pad(s)}`;
}

// ✅ FIX: 훅/중괄호 복구
function Countdown({ endAt }: { endAt?: string | number | Date }) {
  const [now, setNow] = useState<number>(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  if (!endAt) return null;
  const end = new Date(endAt).getTime();
  const timeStr = formatRemaining(end, now);
  return <div className="text-xs text-slate-500">⏳ 혜택 종료까지 {timeStr}</div>;
}



function Header({ title, onClose, rightExtra }: any) {
  return (
    <div className="sticky top-0 z-20 w-full bg-[#0b1b2b] text-white hd-header">
      <div className="mx-auto max-w-md px-4 py-3 flex items-center justify-between">
        {/* 왼쪽: 현대 로고 + 제목 */}
        <div className="flex items-center gap-2.5">
        <img
          src={`${import.meta.env.BASE_URL}hyundai-symbol-white.png`}
          alt="Hyundai"
          className="h-4 w-auto select-none translate-y-[1px]"  // ⬅️ 살짝 줄이고 세로 미세 보정
        />
        <span className="text-[16px] font-semibold tracking-tight leading-none">
          {title}
        </span>
      </div>


        {/* 오른쪽: 닫기 + 기타 버튼 */}
        <div className="flex items-center gap-2">
          {rightExtra}
          <button
            aria-label="닫기"
            onClick={onClose}
            className="rounded-full bg-white/10 w-8 h-8 flex items-center justify-center text-lg leading-none hover:bg-white/20"
          >
            ×
          </button>
        </div>
      </div>
    </div>
  );
}



function Home({ goModelHub, goBuilder, openNetwork, openFaq, openModel }: any) {
  const { send } = useChat();
  const Tile = ({ children }: any) => (
    <button className="w-full rounded-2xl bg-white shadow-sm hover:shadow-md transition px-4 py-5 text-left border border-slate-200">
      {children}
    </button>
  );
  return (
    <div className="mx-auto max-w-md px-4 pb-4 pt-4">
      <div className="rounded-2xl bg-white shadow-sm border border-slate-200 p-4 mb-4">
        <p className="text-slate-700 text-lg leading-snug">
          <span className="mr-1">👋</span>안녕하세요!
          <br />
          현대차 디지털 쇼룸입니다.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Tile>
          <div className="text-slate-900 font-medium">인기모델 보기</div>
          <div className="text-slate-500 text-sm mt-1">데이터 기반 TOP</div>
          <div className="mt-3">
            
            <button
              onClick={() => {
                //openModel({ preset: 'trend' });           // ← 변경: 모달 오픈
                //send(toPrompt({ type: 'open_model_trend' }));
                openModel({ preset: 'trend' });
              }}
              className="rounded-xl bg-[#0b1b2b] text-white text-sm px-3 py-2"
            >
              열기
            </button>

          </div>
        </Tile>
        <Tile>
          <div className="text-slate-900 font-medium">내 차 만들기</div>
          <div className="text-slate-500 text-sm mt-1">옵션 구성/견적</div>
          <div className="mt-3">
          <button
            type="button"
            className="rounded-xl bg-[#0b1b2b] text-white text-sm px-3 py-2"
            onClick={() => {
              if (BUILDER_ENABLED) {
                // goBuilder();   // 진짜 빌더 연결 시
              }
              send("내 차 만들기");  // 항상 폴백 발화
            }}
          >
            시작
          </button>
          </div>
        </Tile>


        <Tile>
          <div className="text-slate-900 font-medium">서비스센터 찾기</div>
          <div className="text-slate-500 text-sm mt-1">가까운 순 표시</div>
          <div className="mt-3">
            <button
              onClick={() => {
                openNetwork(null);
                send(toPrompt({ type: 'open_network' }));
              }}
              className="rounded-xl bg-[#0b1b2b] text-white text-sm px-3 py-2"
            >
              열기
            </button>
          </div>
        </Tile>
        <Tile>
          <div className="text-slate-900 font-medium">전기차 정보</div>
          <div className="text-slate-500 text-sm mt-1">충전/보조금/유지비</div>
          <div className="mt-3">
            <button
              onClick={() => send(toPrompt({ type: 'recommend_ev' }))}
              className="rounded-xl bg-[#0b1b2b] text-white text-sm px-3 py-2"
            >
              보기
            </button>

          </div>
        </Tile>
      </div>
      <div className="mt-5 flex flex-wrap gap-2">
        <button
          onClick={() => openModel({ preset: 'trend', promo: true })}
          className="rounded-full border border-slate-300 bg-white px-4 py-2 text-sm text-slate-700 hover:border-[#0b1b2b] hover:text-[#0b1b2b]"
        >
          혜택
        </button>

        {/* ★ 추가: 드라이빙 라운지 프리셋으로 네트워크 허브 열기 */}
        <button
          onClick={() => openNetwork('드라이빙 라운지')}
          className="rounded-full border border-slate-300 bg-white px-4 py-2 text-sm text-slate-700 hover:border-[#0b1b2b] hover:text-[#0b1b2b]"
        >
          시승/예약
        </button>


        <button
          onClick={openFaq}
          className="rounded-full border border-slate-300 bg-white px-4 py-2 text-sm text-slate-700 hover:border-[#0b1b2b] hover:text-[#0b1b2b]"
        >
          자주 묻는 질문
        </button>
      </div>
    </div>
  );
}

function ModelHub({ preset = 'trend', promo = false, promoOnly, setPromoOnly, goBuilder, openNetwork }: any) {
  const [q, setQ] = useState('');
  const [power, setPower] = useState(preset === 'ev' ? 'EV' : 'ALL');
  const [sort, setSort] = useState(preset === 'trend' ? 'trend' : 'price');
  const promoFlag = typeof promoOnly === 'boolean' ? promoOnly : !!promo;

  const filtered = useMemo(() => {
    let arr = [...MODELS] as any[];
    if (power !== 'ALL') arr = arr.filter((m) => m.type === power);
    if (q) arr = arr.filter((m) => m.name.includes(q));
    if (sort === 'price') arr.sort((a, b) => a.priceFrom - b.priceFrom);
    if (sort === 'trend') arr.sort((a, b) => (b.popular ? 1 : 0) - (a.popular ? 1 : 0));
    if (promoFlag) arr = arr.filter((m) => m.promo);
    // ✅ [추가] 이미 종료된 프로모션은 제외
    arr = arr.filter((m) => {
      if (!m.promoEndsAt) return true;
      return new Date(m.promoEndsAt) > new Date();
    });

    return arr;
  }, [q, power, sort, promoFlag]);

  return (
    <div className="mx-auto max-w-md px-4 pb-32 pt-2">
      <div className="flex gap-2 mb-3">
        {[{ label: 'All', v: 'ALL' }, { label: 'EV', v: 'EV' }, { label: 'HEV', v: 'HEV' }].map((c) => (
          <button
            key={c.label}
            onClick={() => setPower(c.v)}
            className={`rounded-full border px-3 py-1 text-sm ${
              power === c.v ? 'bg-[#0b1b2b] text-white border-transparent' : 'bg-white text-slate-700 border-slate-300'
            }`}
          >
            {c.label}
          </button>
        ))}
        <div className="ml-auto">
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value)}
            className="rounded-full border border-slate-300 bg-white px-3 py-1 text-sm"
          >
            <option value="trend">정렬: 트렌드</option>
            <option value="price">정렬: 가격</option>
          </select>
        </div>
      </div>

      {promoFlag && (
        <div className="mb-3 rounded-xl border border-[#0b1b2b]/20 bg-[#0b1b2b]/5 px-4 py-3 text-sm text-slate-800">
          현재 <span className="font-semibold">프로모션 대상</span> 모델만 보고 있어요.
          <button onClick={() => setPromoOnly && setPromoOnly(false)} className="ml-2 text-[#0b1b2b] underline">
            끄기
          </button>
        </div>
      )}

      <div className="mb-3">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="모델명 검색"
          className="w-full rounded-xl border border-slate-300 px-3 py-2"
        />
      </div>

      <div className="space-y-3">
        {filtered.map((m) => (
          <div key={m.id} className="rounded-2xl bg-white border border-slate-200 p-4 shadow-sm">
            <div className="flex items-center justify-between">
              <div className="text-lg font-semibold text-slate-900">{m.name}</div>
              <div className="flex items-center gap-2">
                {m.promo && <span className="text-xs rounded-full bg-amber-500 text-white px-2 py-1">혜택</span>}
                {m.popular && <span className="text-xs rounded-full bg-slate-800 text-white px-2 py-1">인기</span>}
              </div>
            </div>
            <div className="text-slate-500 text-sm mt-1">
              {m.type} · {m.body}
            </div>
            {/* 1) 정가 (항상 노출) */}
            {/* 가격 영역 */}
            {(() => {
              const hasPromo = m.promo && (typeof m.promoDiscountPct === 'number' || typeof m.promoDiscountAmount === 'number');
              if (hasPromo) {
                const r = calcDiscount(m.priceFrom, m.promoDiscountPct as number, m.promoDiscountAmount as number);
                const discountText = r ? `(-${formatWonShort(r.discountAmt)}${r.pctText ? `, ${r.pctText}` : ''})` : '';
                return (
                  <>
                    <div className="text-slate-900 font-semibold mt-2">
                      혜택가 {formatPrice(r!.finalPrice)}부터
                    </div>
                    <div className="text-slate-500 text-sm mt-1">
                      정가 <s>{formatPrice(m.priceFrom)}부터</s> · {discountText}
                    </div>
                  </>
                );
              }
              // 프로모션 없을 때 기본 표기
              return (
                <div className="text-slate-900 font-semibold mt-2">
                  {formatPrice(m.priceFrom)}부터
                </div>
              );
            })()}


           

            {/* 3) 카운트다운 (프로모션 있을 때만) */}
            {m.promo && m.promoEndsAt && (
              <div className="mt-1">
                <Countdown endAt={m.promoEndsAt} />
              </div>
            )}





            {/* 버튼 영역 교체 */}
            <div className="mt-3 flex gap-2">
              <button
                className="rounded-xl border border-slate-300 px-3 py-2 text-sm"
                onClick={() =>
                  window.dispatchEvent(
                    new CustomEvent("open-soon", { detail: "비교 기능은 곧 오픈 예정입니다." })
                  )
                }
              >
                비교에 추가
              </button>

              <button
                className="rounded-xl border border-slate-300 px-3 py-2 text-sm"
                onClick={() =>
                  window.dispatchEvent(
                    new CustomEvent("open-soon", { detail: "내 차 만들기는 곧 오픈 예정입니다." })
                  )
                }
              >
                내 차 만들기
              </button>

              <button
  onClick={() => {
    const phone = "080-600-6000";
    const cleaned = phone.replace(/[^0-9+]/g, "");
    const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    if (isMobile) {
      window.location.href = `tel:${cleaned}`;
    } else {
      window.prompt("전화번호를 복사하세요.", phone);
    }
  }}
  className="rounded-xl bg-[#0b1b2b] text-white px-3 py-2 text-sm"
>
  구매 상담
</button>


            </div>

          </div>
        ))}
      </div>
    </div>
  );
}

// ▼ ModelHub 정의 바로 아래에 추가
function ModelOverlay({
  open,
  onClose,
  opts,
  goBuilder,
  openNetwork,
}: {
  open: boolean;
  onClose: () => void;
  opts?: any;
  goBuilder: () => void;
  openNetwork: (presetKind?: string | null) => void;
}) {
  const [promoOnly, setPromoOnly] = useState(!!opts?.promo);
  if (!open) return null;

  const header = (
    <div className="sticky top-0 z-10 bg-[#0b1b2b] text-white">
      <div className="mx-auto max-w-md px-4 py-4 flex items-center gap-3">
        <button
          onClick={onClose}
          className="rounded-lg bg-white/10 px-3 py-2 text-sm hover:bg-white/20"
        >
          닫기
        </button>
        <h2 className="text-base font-semibold tracking-tight">모델 허브</h2>
        <button
          aria-pressed={promoOnly}
          onClick={() => setPromoOnly((v) => !v)}
          className={`ml-auto flex items-center gap-1 rounded-full border px-3 py-1 text-sm transition-colors ${
            promoOnly
              ? 'bg-white text-[#0b1b2b] border-white'
              : 'bg-white/10 text-white border-white/20'
          }`}
        >
          <span aria-hidden>🎁</span>
          <span>혜택</span>
        </button>
      </div>
    </div>
  );

  const body = (
    <div className="fixed inset-0 z-[60]" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="absolute inset-0 bg-white">
        {header}
        <div className="h-[calc(100vh-56px)] overflow-y-auto">
          <div className="mx-auto max-w-md">
            <ModelHub
              preset={opts?.preset ?? 'trend'}
              promo={opts?.promo}
              promoOnly={promoOnly}
              setPromoOnly={setPromoOnly}
              goBuilder={goBuilder}
              openNetwork={openNetwork}
            />
          </div>
        </div>
      </div>
    </div>
  );

  return ReactDOM.createPortal(body, document.body);
}


function NetworkSheet({ open, onClose, presetKind }: any) {
  const [kind, setKind] = useState(presetKind || '서비스센터');
  const [evOnly, setEvOnly] = useState(false);
  const [limit, setLimit] = useState(4);
  const rows = useMemo(() => withCoordsFromUrl(centers as any[]), []);

    // ✅ 미니 가드: 닫기·로딩 안정성 보정
    const [loading, setLoading] = useState(false);
    const [refreshKey, setRefreshKey] = useState(0);
  
    // 닫기는 항상 작동하도록 보장
    const safeClose = () => {
      setLoading(false);  // 로딩 중이라도 닫히게
      onClose();
    };
  
    // 새로고침은 상태키로 리렌더 유도 (위치 재측정)
    const safeRefresh = () => {
      if (loading) return;
      setRefreshKey(k => k + 1);
    };
  
    // open·refreshKey 변화 시에만 위치 갱신 (finally로 상태 보정)
    useEffect(() => {
      if (!open) return;
      let cancelled = false;
  
      (async () => {
        setLoading(true);
        try {
          const g = await getGeoOnce(true);
          if (!cancelled && g) {
            setGeo(g);
            geoRef.current = g;
          }
        } catch (err) {
          console.warn('위치 요청 실패:', err);
        } finally {
          if (!cancelled) setLoading(false);
        }
      })();
  
      return () => {
        cancelled = true;
        setLoading(false);
      };
    }, [open, refreshKey]);
  

  // 내 위치 (마지막 유효 좌표 보존)
  const [geo, setGeo] = useState<{ lat: number; lng: number } | null>(null);
  const geoRef = useRef<{ lat: number; lng: number } | null>(null);
  const [geoLoading, setGeoLoading] = useState(false);

  // 버튼 ref (탭 포커스 유지용)
  const kindBtnRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  const focusKind = (k: string, tries = 3) => {
    if (tries <= 0) return;
    const el = kindBtnRefs.current[k];
    if (el) {
      el.focus();
      el.scrollIntoView({ block: 'nearest', inline: 'center' });
    } else {
      requestAnimationFrame(() => focusKind(k, tries - 1));
    }
  };
  
  

  // 시트 열릴 때 preset 반영 + 포커스
  useEffect(() => {
    if (!open) return;
    const next = presetKind || '서비스센터';
    setKind(next);
    setEvOnly(false);
    setLimit(4);
    requestAnimationFrame(() => focusKind(next));
  }, [open, presetKind]);

  // 열려있을 때 preset만 변경되는 경우
  useEffect(() => {
    if (!open) return;
    const next = presetKind || '서비스센터';
    setKind(next);
    requestAnimationFrame(() => focusKind(next));
  }, [presetKind, open]);

  // 최초 열릴 때 한 번 시도(권한 이미 허용된 케이스에서는 즉시 세팅)
  useEffect(() => {
    if (!open) return;
    (async () => {
      try {
        const g = await getGeoOnce(false); // 강제 프롬프트 X
        if (g) {
          setGeo(g);
          geoRef.current = g;
        }
      } catch {}
    })();
  }, [open]);

  // 새로고침(내 위치 재측정) — 기존 좌표 유지, 성공 시에만 갱신
  const onRefreshGeo = async () => {
    setGeoLoading(true);
    try {
      const g = await getGeoOnce(true); // 프롬프트 허용
      if (g) {
        setGeo(g);
        geoRef.current = g;
      }
    } finally {
      setGeoLoading(false);
    }
  };

  // 안전한 거리계산 & 포맷
  const haversine = (lat1: number, lon1: number, lat2: number, lon2: number) => {
    const R = 6371;
    const toRad = (d: number) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  };
  const fmtKm = (v: any, fallback?: any) => {
    const n = Number(v);
    if (Number.isFinite(n)) return `${n.toFixed(1)}km`;
    const m = Number(fallback);
    return Number.isFinite(m) ? `${m.toFixed(1)}km` : '';
  };
  const isMobile = () =>
    /Android|iPhone|iPad|iPod|Windows Phone|webOS/i.test(navigator.userAgent);
  const handleCall = (phone?: string) => {
    if (!phone) return;
    const cleaned = phone.replace(/[^0-9+]/g, '');
    if (isMobile()) {
      window.location.href = `tel:${cleaned}`;
    } else {
      // 간단 복사 팝업
      window.prompt('전화번호를 복사하세요.', phone);
    }
  };

  // 리스트 생성
  const list = useMemo(() => {
    const g = geoRef.current || geo;

    let arr = rowsBase.filter((c) => (kind ? c.kind === kind : true));
    if (evOnly) {
      arr = arr.filter(
        (c) => c.ev_ok === true || (Array.isArray(c.types) && c.types.includes('ev'))
      );
    }

    // 거리 계산: lat/lng가 있는 것만 Haversine, 나머지는 원본 distance_km 유지
    const withD = arr.map((c) => {
      let d = Number(c.distance_km);
      if (
        g &&
        typeof c.lat === 'number' && Number.isFinite(c.lat) &&
        typeof c.lng === 'number' && Number.isFinite(c.lng)
      ) {
        d = haversine(g.lat, g.lng, c.lat, c.lng);
      }
      return { ...c, _dKm: d };
    });

    withD.sort((a, b) => (Number(a._dKm) || 1e9) - (Number(b._dKm) || 1e9));
    return withD.slice(0, limit);
  }, [kind, evOnly, limit, geo?.lat, geo?.lng]);

  // ESC 닫기
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && safeClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose, safeClose]);

  if (!open) return null;

  const sheet = (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true">
      <div
        className="absolute inset-0 bg-black/40 z-0 pointer-events-auto touch-none"
        onClick={safeClose}
      />
      <div
        className="absolute inset-x-0 bottom-0 mx-auto max-w-md rounded-t-2xl bg-white shadow-xl z-10
                   pointer-events-auto h-[70vh] md:h-[65vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 헤더: 타이틀 오른쪽에 새로고침 버튼 배치 */}
        <div className="p-4 border-b border-slate-200 flex items-center gap-2">
          <div className="h-1.5 w-12 rounded-full bg-slate-300 mx-auto absolute left-1/2 -translate-x-1/2 -top-2" />
          <div className="text-slate-900 font-semibold flex items-center gap-2">
            네트워크 검색
            <button
              aria-label="내 위치로 정렬"
              title="내 위치로 정렬"
              onClick={safeRefresh}
              className="rounded-lg px-2 py-1 text-slate-500 hover:text-slate-700 hover:bg-slate-100"
            >
              {geoLoading ? '…' : '⟳'}
            </button>
          </div>
          <button
            className="ml-auto text-slate-500"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              safeClose();
              window.dispatchEvent(new CustomEvent("close-network"));
            }}
          >
            닫기
          </button>

        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4 space-y-3
                        overscroll-contain touch-pan-y [-webkit-overflow-scrolling:touch]">
          <div className="flex gap-2">
            {['지점/대리점', '드라이빙 라운지', '서비스센터'].map((k) => (
              <button
                key={k}
                ref={(el) => (kindBtnRefs.current[k] = el)}
                onClick={() => setKind(k)}
                className={`rounded-full border px-3 py-1 text-sm ${
                  kind === k
                    ? 'bg-[#0b1b2b] text-white border-transparent'
                    : 'bg-white border-slate-300'
                }`}
                aria-pressed={kind === k}
                tabIndex={0}
              >
                {k}
              </button>
            ))}
            <label className="ml-auto flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={evOnly}
                onChange={(e) => setEvOnly(e.target.checked)}
              />{' '}
              EV 가능만
            </label>
          </div>

          <div className="space-y-2">
            {list.map((l: any, idx: number) => (
              <div
                key={`${kind}::${String(l.id ?? '')}::${String(l.name ?? '')}::${idx}`}
                className="rounded-xl border border-slate-200 p-3 flex items-center justify-between"
              >
                <div>
                  <div className="font-medium text-slate-900">{l.name}</div>
                  <div className="text-sm text-slate-500">
                    {l.kind} · {fmtKm(l._dKm, l.distance_km)}
                  </div>
                </div>
                <div className="flex gap-2">
                 <button
                   className="rounded-lg border border-slate-300 px-2 py-1 text-sm"
                   onClick={() => window.open(toGmapsUrl(l), '_blank', 'noopener,noreferrer')}
                 >
                   지도
                 </button>
                  <button
                    className="rounded-lg bg-[#0b1b2b] text-white px-2 py-1 text-sm"
                    onClick={() => handleCall(l.phone)}
                  >
                    전화
                  </button>
                </div>
              </div>
            ))}
          </div>

          {/* 더보기 */}
          <div className="pt-2">
            {limit < 10 && (
              <button
                onClick={() => setLimit(limit + 5)}
                className="w-full rounded-xl border border-slate-300 px-4 py-2"
              >
                더보기
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );

  return ReactDOM.createPortal(sheet, document.body);
}




// App.merged.tsx 안의 기존 function FaqSheet만 통째로 교체
function FaqSheet({
  open,
  onClose,
  tab: extTab,
  setTab: extSetTab,
}: {
  open: boolean;
  onClose: () => void;
  tab?: string;
  setTab?: (t: string) => void;
}) {
  const { send } = useChat();                // ← 클릭 시 챗봇 발화
  const [data, setData] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 외부에서 tab 미지정 시 로컬 탭 사용
  const [localTab, setLocalTab] = useState<string>("전체");
  const tab = extTab ?? localTab;
  const setTab = extSetTab ?? setLocalTab;

  // faq.json 로드 (public/faq.json)
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    fetch("/faq.json", { cache: "force-cache" })
      .then((r) => {
        if (!r.ok) throw new Error(`faq.json load fail: ${r.status}`);
        return r.json();
      })
      .then((json) => setData(Array.isArray(json) ? json : []))
      .catch((e) => setError(e?.message || "faq.json 로드 실패"))
      .finally(() => setLoading(false));
  }, [open]);

  // B/C 변형 제거, 카테고리 생성(가나다 정렬)
  const base = useMemo(() => data.filter((d) => !/-[bc]$/i.test(String(d.id))), [data]);
  const categories = useMemo(() => {
    const set = new Set<string>();
    base.forEach((d) => set.add((d?.category ?? "기타").toString().trim()));
  
    let arr = Array.from(set).sort((a, b) => a.localeCompare(b, "ko"));
  
    // Top 50 카테고리를 따로 분리해서 전체 바로 뒤로 이동
    const hasTop = arr.includes("Top 50");
    if (hasTop) {
      arr = ["Top 50", ...arr.filter((c) => c !== "Top 50")];
    }
  
    // 현재 탭이 사라졌다면 전체로 보정
    if (tab !== "전체" && !arr.includes(tab)) setTab("전체");
  
    // '전체' + 나머지 (Top 50이 있으면 두 번째 위치)
    return ["전체", ...arr];
  }, [base, tab, setTab]);
  

  const filtered = useMemo(() => {
    if (tab === "전체") return base;
    return base.filter((d) => d.category === tab);
  }, [base, tab]);

  const handleClick = async (q: string, id: string) => {
    await send(q);       // ← 챗봇으로 바로 발화
    onClose?.();         // ← 시트 닫기
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="absolute inset-x-0 bottom-0 mx-auto max-w-md rounded-t-2xl bg-white shadow-xl">
        <div className="p-4 border-b border-slate-200 flex items-center gap-2">
          <div className="h-1.5 w-12 rounded-full bg-slate-300 mx-auto absolute left-1/2 -translate-x-1/2 -top-2" />
          <div className="text-slate-900 font-semibold">자주 묻는 질문</div>
          <button className="ml-auto text-slate-500" onClick={onClose}>닫기</button>
        </div>

        <div className="p-4 space-y-3">
          {/* Tabs (카테고리) — 보이는 얇은 가로 스크롤 */}
          <div className="flex overflow-x-auto flex-nowrap items-center gap-2 pb-1 -mx-4 px-4 thin-scrollbar ios-momentum">
            {categories.map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`shrink-0 rounded-full border px-3 py-1 text-sm ${
                  tab === t
                    ? "bg-[#0b1b2b] text-white border-transparent"
                    : "bg-white border-slate-300"
                }`}
              >
                {t}
              </button>
            ))}
          </div>



          {/* 리스트 */}
          {loading && <div className="text-sm text-slate-500">불러오는 중…</div>}
          {error && <div className="text-sm text-red-500">{error}</div>}
          {!loading && !error && (
            <div className="space-y-2 max-h-[70vh] overflow-auto">
              {filtered.map((d) => (
                <button
                  key={d.id}
                  className="w-full text-left rounded-xl border border-slate-200 px-3 py-3 hover:bg-slate-50 transition faq-item"
                  onClick={() => handleClick(d.q, d.id)}
                >
                  <div className="text-slate-900 text-[14px] leading-[1.45]">{d.q}</div>
                  <div className="text-slate-400 text-[11px] leading-[1.35] mt-1">#{d.category}</div>
                </button>              
              ))}
              {filtered.length === 0 && (
                <div className="text-sm text-slate-500 py-6 text-center">표시할 항목이 없습니다.</div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}


function GlobalDock({ open, onHome, onAgent, onHelp, onNetwork, onChat }: any) {
  if (!open) return null;
  return (
    <div className="fixed left-0 right-0 bottom-20 mx-auto max-w-md px-3 z-30">
      <div className="grid grid-cols-5 gap-2 rounded-2xl bg-white/95 backdrop-blur border border-slate-200 shadow-lg p-2">
        <button onClick={onHome} className="flex flex-col items-center py-2 text-sm text-slate-800">
          <span className="text-lg">🏠</span>
          <span>처음으로</span>
        </button>
        <button onClick={onAgent} className="flex flex-col items-center py-2 text-sm text-slate-800">
          <span className="text-lg">🎧</span>
          <span>상담사</span>
        </button>
        <button onClick={onHelp} className="flex flex-col items-center py-2 text-sm text-slate-800">
          <span className="text-lg">❔</span>
          <span>도움말</span>
        </button>
        <button onClick={onNetwork} className="flex flex-col items-center py-2 text-sm text-slate-800">
          <span className="text-lg">📍</span>
          <span>네트워크</span>
        </button>
        <button onClick={onChat} className="flex flex-col items-center py-2 text-sm text-slate-800">
          <span className="text-lg">💬</span>
          <span>대화</span>
        </button>
      </div>
    </div>
  );
}

// 🔽 GlobalDock() 끝난 바로 아래에 추가
function SoonModal({ msg, onClose }: { msg: string; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-[1300] bg-black/40" onClick={onClose}>
      <div
        className="fixed inset-x-4 top-[20%] md:inset-x-[max(0px,calc(50%-240px))] rounded-2xl bg-white shadow-xl p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-[15px] text-slate-800">{msg}</div>
        <div className="mt-3 flex justify-end">
          <button
            className="rounded-lg px-3 py-2 text-[13px] bg-slate-900 text-white"
            onClick={onClose}
          >
            확인
          </button>
        </div>
      </div>
    </div>
  );
}

/* --------------------------------------
   App 루트: 입력창 하나 + 인라인 대화
---------------------------------------*/
export default function App() {
  // App() 내부 state들 맨 위 근처에 추가
  const [modelOpen, setModelOpen] = useState(false);
  const [modelOpts, setModelOpts] = useState<any>({});
  const [modelRev, setModelRev] = useState(0); // 재마운트용(선택)

  const [networkRev, setNetworkRev] = useState(0);
  const [page, setPage] =
    useState<'home' | { name: 'model'; opts?: any } | { name: 'builder1' }>('home');
  const [networkOpen, setNetworkOpen] = useState(false);
  const [networkPreset, setNetworkPreset] = useState<string | null>(null);
  const [dockOpen, setDockOpen] = useState(false);
  const [promoOnly, setPromoOnly] = useState(false);
  const [faqOpen, setFaqOpen] = useState(false);
  const [faqTab, setFaqTab] = useState('전체');
  // 준비중 팝업 상태
  const [soonMsg, setSoonMsg] = useState<string | null>(null);
  const chatRef = useRef<HTMLDivElement>(null);

  // App() 내부: 모달 오픈 함수 추가
  const openModel = (opts?: any) => {
    setModelOpts(opts || {});
    setModelOpen(true);
    setModelRev((r) => r + 1);
  };

  // body scroll lock (모달 열릴 때)
  useEffect(() => {
    const lock = networkOpen || faqOpen || modelOpen;
    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;

    if (lock) {
      document.body.style.overflow = 'hidden';
      if (scrollbarWidth > 0) document.body.style.paddingRight = `${scrollbarWidth}px`;
    } else {
      document.body.style.overflow = '';
      document.body.style.paddingRight = '';
    }

    return () => {
      document.body.style.overflow = '';
      document.body.style.paddingRight = '';
    };
  }, [networkOpen, faqOpen, modelOpen]);

  // 전역 이벤트 리스너는 1회만 등록
  useEffect(() => {
    const onOpenModelHub = (ev: Event) => {
      const e = ev as CustomEvent<any>;
      const { tab = 'ALL', promoOnly = false } = e.detail || {};
      const preset = tab === 'EV' ? 'ev' : tab === 'HEV' ? 'hev' : 'trend';
      openModel({ preset, promo: promoOnly });
    };

    const onOpenFaq = () => setFaqOpen(true);

    // ★★★ 추가: 네트워크(시승/예약) 열기
    const onOpenNetwork = (ev: Event) => {
      const e = ev as CustomEvent<any>;
      const tab = e?.detail?.tab ?? '드라이빙 라운지';
      setNetworkPreset(tab);
      setNetworkOpen(true);
      setNetworkRev((r) => r + 1);
    };

    window.addEventListener('open-model-hub', onOpenModelHub as EventListener);
    window.addEventListener('open-faq', onOpenFaq as EventListener);
    window.addEventListener('open-network', onOpenNetwork as EventListener); // ★ 추가


    return () => {
      window.removeEventListener('open-model-hub', onOpenModelHub as EventListener);
      window.removeEventListener('open-faq', onOpenFaq as EventListener);
      window.removeEventListener('open-network', onOpenNetwork as EventListener); // ★ 추가
    };
  }, []);


  // ✅ 닫기 이벤트 (서비스센터/시승예약 오버레이 전용)
  useEffect(() => {
    const onCloseNetwork = () => setNetworkOpen(false);
    window.addEventListener("close-network", onCloseNetwork);
    return () => window.removeEventListener("close-network", onCloseNetwork);
  }, []);

  // 기존 useEffect (스크롤락 + open-model-hub/open-faq) ← 건드리지 말기

  

  
  

  useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail;
      setSoonMsg(detail ?? "해당 기능은 곧 오픈 예정입니다.");
    };
    window.addEventListener("open-soon", onOpen as EventListener);
    return () => window.removeEventListener("open-soon", onOpen as EventListener);
  }, []); // ← 의존성 없음 (전역 리스너 1회 등록)



  const goModelHub = (opts?: any) => {
    setPromoOnly(!!(opts && opts.promo));
    setPage({ name: 'model', opts });
  };
  const goBuilder = () => setPage({ name: 'builder1' });
  const openNetwork = (presetKind?: string | null) => {
    setNetworkPreset(presetKind || null);
    setNetworkOpen(true);
    setNetworkRev((r) => r + 1); // 열릴 때마다 마운트 리셋
  };
  const headerTitle =
    page === 'home'
      ? '현대차 디지털 쇼룸'
      : (page as any).name === 'model'
      ? '모델 허브'
      : '구성/견적 - Step1';

  return (
    <ChatProvider>
      <div className="min-h-screen bg-slate-50 text-slate-900">
        <Header
          title={headerTitle}
          onBack={page === 'home' ? undefined : () => setPage('home')}
          onClose={() => {
            // 팝업으로 열린 경우 → 창 닫기
            if (typeof window !== 'undefined' && window.opener && !window.opener.closed) {
              try { window.open('', '_self'); } catch {}
              window.close();
              return;
            }
            // 임베드/단일 페이지로 열린 경우 → 기존 동작
            setNetworkOpen(false);
            setPage('home');
                  }}
          rightExtra={
            typeof page === 'object' && (page as any).name === 'model' ? (
              <button
                aria-pressed={promoOnly}
                onClick={() => setPromoOnly(!promoOnly)}
                className={`flex items-center gap-1 rounded-full border px-3 py-1 text-sm transition-colors ${
                  promoOnly ? 'bg-white text-[#0b1b2b] border-white' : 'bg-white/10 text-white border-white/20'
                }`}
              >
                <span aria-hidden>🎁</span>
                <span>혜택</span>
              </button>
            ) : null
          }
        />

        {/* 홈은 항상 상단에 유지 */}
        {page === 'home' && (
          <Home
            goModelHub={goModelHub}
            goBuilder={goBuilder}
            openNetwork={openNetwork}
            openFaq={() => setFaqOpen(true)}
            openModel={openModel}  
          />
        )}

        {typeof page === 'object' && (page as any).name === 'model' && (
          <ModelHub
            preset={(page as any).opts?.preset}
            promo={(page as any).opts?.promo}
            promoOnly={promoOnly}
            setPromoOnly={setPromoOnly}
            goBuilder={goBuilder}
            openNetwork={openNetwork}
          />
        )}

        {typeof page === 'object' && (page as any).name === 'builder1' && (
          <div className="mx-auto max-w-md px-4 pb-32 pt-4">Builder Step1(더미)</div>
        )}

        <NetworkSheet key={networkRev} open={networkOpen} onClose={() => setNetworkOpen(false)} presetKind={networkPreset} />
        <FaqSheet open={faqOpen} onClose={() => setFaqOpen(false)} tab={faqTab} setTab={setFaqTab} />

        <ModelOverlay
        key={modelRev}
        open={modelOpen}
        onClose={() => setModelOpen(false)}
        opts={modelOpts}
        goBuilder={goBuilder}
        openNetwork={openNetwork}
      />

        {/* 인라인 채팅 영역 */}
        <div ref={chatRef} className="mx-auto max-w-md px-4 pb-32 pt-4">
          <InlineChat
            onOpenNetwork={openNetwork}
            onOpenModel={openModel}    // ★ 추가
            onGoBuilder={goBuilder}    // ★ 추가
            onOpenFaq={() => setFaqOpen(true)}   // ★ 추가
            networkOpen={networkOpen}
            modelOpen={modelOpen}
            modelRev={modelRev}
            currentPreset={networkPreset}  // ★ 외부 프리셋 동기화
            onOpenModelHub={(tab) => {
                 // 탭 → 모델허브 preset 매핑
                 const preset = tab === 'EV' ? 'ev' : tab === 'HEV' ? 'hev' : 'trend';
                 openModel({ preset });  // 풀페이지 모델 허브 모달 오픈
               }}
          />
        </div>

        {/* 하단 입력창: 유일한 입력 */}
        <DockInput
          onSend={() => {
            requestAnimationFrame(() => {
              window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
            });
          }}
        />

        {/* 글로벌 도크 (퀵 액션) */}
        <GlobalDock
          open={dockOpen}
          onHome={() => {
            setPage('home');
            setDockOpen(false);
          }}
          onAgent={() => {
            alert('상담사 채팅(더미)');
            setDockOpen(false);
          }}
          onHelp={() => {
            alert('도움말(더미)');
            setDockOpen(false);
          }}
          onNetwork={() => {
            openNetwork(null);
            setDockOpen(false);
          }}
          onChat={() => {
            window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
            setDockOpen(false);
          }}
        />
      </div>
      {soonMsg && <SoonModal msg={soonMsg} onClose={() => setSoonMsg(null)} />}
    </ChatProvider>
  );
}

/* --------------------------------------
   DockInput: 입력창 하나만 존재
---------------------------------------*/
function DockInput({ onSend }: { onSend: (t: string) => void }) {
  const { send, busy } = useChat();
  const [dockOpen, setDockOpen] = useState(false);
  const [msg, setMsg] = useState('');
  return (
    <div className="fixed bottom-0 left-0 right-0 mx-auto max-w-md border-t border-slate-200 bg-white p-3 z-40">
      <div className="flex items-center gap-2">
      <button
        aria-label="처음으로"
        className="w-10 h-10 flex items-center justify-center text-slate-600 hover:text-slate-800 transition-transform duration-200"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setDockOpen(true);   // 바텀시트 열기 (열려있으면 그대로)
          send("처음으로");        // 바로 사용자 발화로 넣기
        }}
      >
        <HomeIcon />
</button>



        <div className="relative flex-1">
          <input
            value={msg}
            onChange={(e) => setMsg(e.target.value)}
            onKeyDown={async (e) => {
              if (e.key === 'Enter' && msg.trim()) {
                await send(msg);
                onSend(msg);
                setMsg('');
              }
            }}
            placeholder="메시지를 입력하세요…"
            className="w-full rounded-xl border border-slate-300 px-3 pr-12 py-2"
          />
          <button
            aria-label="보내기"
            onClick={async () => {
              if (msg.trim()) {
                await send(msg);
                onSend(msg);
                setMsg('');
              }
            }}
            disabled={!msg.trim() || busy}
            className={`absolute right-2 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full flex items-center justify-center text-sm ${
              msg.trim() ? 'bg-[#0b1b2b] text-white' : 'bg-slate-200 text-slate-500 cursor-not-allowed'
            }`}
          >
            ↑
          </button>
        </div>
      </div>
    </div>
  );
}

