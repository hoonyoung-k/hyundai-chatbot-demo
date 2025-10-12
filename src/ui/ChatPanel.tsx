import React, { useEffect, useRef, useState } from "react";
import { useChat } from "../state/chat";
import type { BotReply } from "../logic/router";
import EvInfoCard from "./components/EvInfoCard";

/* ====================== 작은 UI 파편들 ====================== */
function Chips({
  chips,
  onPick,
}: {
  chips?: string[];
  onPick: (c: string) => void;
}) {
  if (!chips?.length) return null;

  const handleClick = (label: string) => {
    const t = (label || "").trim();
    const normalized = t.replace(/\s+/g, "");

    if (t === "혜택") {
      window.dispatchEvent(
        new CustomEvent("open-model-hub", {
          detail: { tab: "ALL", promoOnly: true },
        })
      );
      return;
    }

    if (normalized === "자주묻는질문") {
      window.dispatchEvent(new CustomEvent("open-faq"));
      return;
    }

    if (t === "처음으로") {
      onPick("처음");
      return;
    }

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

function VehicleCard({
  v,
  onAction,
}: {
  v: BotReply["cards"][number] & { type: "vehicle" };
  onAction: (a: string, id?: string) => void;
}) {
  return (
    <div className="hd-card p-4 space-y-2">
      <div className="flex items-center justify-between">
        <div className="card-title">{v.title}</div>
        <div className="flex gap-1">
          {v.badges?.map((b, i) => (
            <span
              key={i}
              className={`badge ${b === "혜택" ? "badge-amber" : ""}`}
            >
              {b}
            </span>
          ))}
        </div>
      </div>
      <div className="card-sub">
        {v.spec?.segment ?? "차량"} · 주행거리 {v.spec?.range_km ?? "-"}km
      </div>
      <div className="price">
        {v.price_from ? `₩${v.price_from.toLocaleString()}부터` : "-"}
      </div>
      <div className="flex gap-2 pt-1">
        {v.cta?.map((c, i) => (
          <button
            key={i}
            className={`hd-btn ${i === 1 ? "hd-btn--primary" : ""}`}
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
  c: BotReply["cards"][number] & { type: "center" };
  onAction: (a: string, id?: string) => void;
}) {
  const km =
    typeof (c as any).distance_km === "number"
      ? (c as any).distance_km.toFixed(1)
      : (c as any).distance_km ?? "";
  return (
    <div className="hd-card p-4 space-y-1">
      <div className="card-title">{c.title}</div>
      <div className="card-sub">
        {c.kind} {km !== "" ? `· ${km}km` : ""} · EV {c.ev_ok ? "가능" : "불가"}
      </div>
      <div className="flex gap-2 pt-2">
        {c.cta?.map((b, i) => (
          <button
            key={i}
            className={`hd-btn ${b.label === "예약" ? "hd-btn--primary" : ""}`}
            onClick={() => onAction(b.action, b.id)}
          >
            {b.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function RichBlock({
  payload,
  onPrompt,
}: {
  payload: BotReply;
  onPrompt: (p: string) => void;
}) {
  const onAction = (action: string, id?: string) => {
    if (action.startsWith("builder")) onPrompt("내 차 만들기 시작하자");
    else if (action.startsWith("lead")) onPrompt("구매 상담 연결해줘");
    else if (action.startsWith("compare")) onPrompt("이 모델 비교에 추가");
    else if (action.startsWith("map")) onPrompt("지도 열어줘");
    else if (action.startsWith("tel")) onPrompt("전화 연결해줘");
    else if (action.startsWith("booking")) onPrompt("시승 예약하고 싶어");
    else if (action === "geo:use") {
      navigator.geolocation.getCurrentPosition(
        (pos) =>
          onPrompt(
            `근처 서비스센터 lat:${pos.coords.latitude} lng:${pos.coords.longitude}`
          ),
        () => alert("위치 권한이 거부되었어요.")
      );
    } else if (action.startsWith("url")) {
      if (id) window.open(id, "_blank", "noopener,noreferrer");
    } else if (action.startsWith("hub")) {
      const detail = { tab: id || "ALL" };
      window.dispatchEvent(new CustomEvent("open-model-hub", { detail }));
    }
  };

  return (
    <div className="space-y-3">
      {payload.sticky_cta && (
        <div className="pt-1">
          <button
            className="hd-btn hd-btn--primary"
            style={{
              width: "fit-content",
              minWidth: 200,
              whiteSpace: "nowrap",
              justifyContent: "center",
              display: "inline-flex",
            }}
            onClick={() =>
              onAction(payload.sticky_cta!.action, payload.sticky_cta!.id)
            }
          >
            {payload.sticky_cta!.label}
          </button>
        </div>
      )}
      <Chips chips={payload.chips} onPick={onPrompt} />
      {payload.cards?.map((it, idx) => {
        if (it.type === "vehicle")
          return <VehicleCard key={idx} v={it as any} onAction={onAction} />;
        if (it.type === "center")
          return <CenterCard key={idx} c={it as any} onAction={onAction} />;
        if (it.type === "ev_recommend")
          return (
            <EvInfoCard
              key={idx}
              onOpenHub={() => onAction("hub:open", "EV")}
            />
          );
        return null;
      })}
    </div>
  );
}

/* ====================== 메인 컴포넌트 ====================== */
type PanelProps = {
  variant?: "inline" | "sheet";
  showInput?: boolean;
  open?: boolean; // 부모 제어 (있으면 우선 반영)
  onClose?: () => void;
};

// 홈 아이콘 (SVG)
const HomeIcon: React.FC<{ size?: number }> = ({ size = 20 }) => (
  <svg
    viewBox="0 0 24 24"
    width={size}
    height={size}
    aria-hidden="true"
    focusable="false"
  >
    <path
      d="M3 10.5L12 3l9 7.5V20a1 1 0 0 1-1 1h-5.5a1 1 0 0 1-1-1v-4.5h-4V20a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-9.5z"
      fill="currentColor"
    />
  </svg>
);

export function ChatPanel({
  variant = "sheet",
  showInput = true,
  open = false,
  onClose,
}: PanelProps) {
  const { history, send, busy } = useChat();
  const [input, setInput] = useState("");
  const [selfOpen, setSelfOpen] = useState(open); // 전역 이벤트로 여닫기
  const scrollRef = useRef<HTMLDivElement>(null);

  // 부모에서 open prop 변경 시 동기화
  useEffect(() => setSelfOpen(open), [open]);

  // 전역 이벤트: 외부에서 시트 열기/닫기, 프롬프트 전달
  useEffect(() => {
    const openH = () => setSelfOpen(true);
    const closeH = () => setSelfOpen(false);
    const promptH = (e: Event) => {
      const ce = e as CustomEvent<string>;
      const msg = (ce.detail || "").trim();
      if (msg) {
        setSelfOpen(true);
        send(msg);
      }
    };
    window.addEventListener("open-chat-sheet", openH);
    window.addEventListener("close-chat-sheet", closeH);
    window.addEventListener("chat:prompt", promptH as any);
    return () => {
      window.removeEventListener("open-chat-sheet", openH);
      window.removeEventListener("close-chat-sheet", closeH);
      window.removeEventListener("chat:prompt", promptH as any);
    };
  }, [send]);

  // 자동 스크롤
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [history]);

  // 홈 아이콘 클릭 → ‘처음’ 발화 (의도 라우팅과 동일하게 맞춤)
  const handleHome = async () => {
    await send("처음"); // Chips의 특수처리와 동일하게 ‘처음’으로 보냄
  };

  const content = (
    <>
      <div className="p-3 border-b flex items-center">
        <div className="font-medium">대화</div>
        {variant === "sheet" && (
          <button
            className="ml-auto text-slate-500"
            onClick={() => {
              setSelfOpen(false);
              onClose?.();
            }}
          >
            닫기
          </button>
        )}
      </div>

      <div ref={scrollRef} className="p-3 h-80 overflow-y-auto space-y-3">
        {history.map((m: any, i: number) => {
          if (m.type === "text") {
            return (
              <div
                key={i}
                className={`flex ${
                  m.from === "user" ? "justify-end" : "justify-start"
                }`}
              >
                <div
                  className={`${
                    m.from === "user"
                      ? "bg-blue-600 text-white"
                      : "bg-gray-100"
                  } rounded-2xl px-3 py-2 max-w-[80%]`}
                >
                  {m.text}
                </div>
              </div>
            );
          }
          return (
            <RichBlock key={i} payload={m.payload} onPrompt={(p) => send(p)} />
          );
        })}
        {history.length === 0 && (
          <div className="text-sm text-gray-500">
            예) 전기차 추천해줘 / 근처 서비스센터
          </div>
        )}
      </div>

      {showInput && (
        <div className="p-3 border-t flex gap-2 hd-inputbar items-center">
          {/* 홈 아이콘 버튼 (기존 + 대체) */}
          <button
            type="button"
            aria-label="처음으로"
            title="처음으로"
            onClick={async () => { await send("처음"); }}
            className="w-9 h-9 rounded-xl border flex items-center justify-center text-slate-700 hover:bg-slate-50"
          >
            {/* HomeIcon SVG 인라인 */}
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
              <path d="M3 10.5L12 3l9 7.5V20a1 1 0 0 1-1 1h-5.5a1 1 0 0 1-1-1v-4.5h-4V20a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-9.5z" fill="currentColor"/>
            </svg>
          </button>

          <input
            className="flex-1 border rounded-xl px-3 py-2"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={async (e) => {
              if (e.key === "Enter" && input.trim()) {
                await send(input);
                setInput("");
              }
            }}
            placeholder="메시지를 입력하세요…"
          />
          <button
            className="px-4 py-2 rounded-xl bg-blue-600 text-white disabled:opacity-50"
            disabled={busy || !input.trim()}
            onClick={async () => {
              if (!input.trim()) return;
              await send(input);
              setInput("");
            }}
          >
            보내기
          </button>
        </div>
      )}

    </>
  );

  if (variant === "inline") {
    return (
      <div className="rounded-2xl bg-white border border-slate-200 shadow-sm overflow-hidden">
        {content}
      </div>
    );
  }

  // 바텀시트
  if (!selfOpen) return null;
  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/30" onClick={() => setSelfOpen(false)} />
      <div className="absolute inset-x-0 bottom-0 mx-auto max-w-md bg-white rounded-t-2xl shadow-xl">
        {content}
      </div>
    </div>
  );
}

export default ChatPanel;
