// src/ui/components/EvInfoCard.tsx
import React, { useMemo, useState } from "react";

type EVModel = {
  id: string; name: string; segment: string; range: number; price: number; badges?: string[]; eff?: number;
};

// ① 샘플(초기엔 하드코딩 → 추후 vehicles.json에서 주입)
const EV_MODELS: EVModel[] = [
  { id:"ioniq5", name:"아이오닉 5", segment:"SUV", range:458, price:52000000, badges:["인기","신형","EV"], eff:5.4 },
  { id:"kona_ev", name:"코나 일렉트릭", segment:"SUV", range:410, price:42000000, badges:["인기","EV"], eff:6.1 },
  { id:"ev6", name:"EV6", segment:"Crossover", range:475, price:55000000, badges:["EV"], eff:5.5 },
];

// ② 보조금(예시값) – 추후 API 연결
const SUBSIDY = { national: 4_000_000, local: { "서울":1_000_000, "경기":800_000, "부산":1_200_000, "대구":600_000 } } as const;

function Chip(props: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button {...props} className={`px-3 h-9 rounded-full border text-sm bg-white hover:bg-slate-50 border-slate-300 text-slate-800 ${props.className||""}`} />;
}
function Tag({children, tone="default"}:{children:React.ReactNode; tone?:"default"|"accent"|"warning"}) {
  const toneMap = { default:"bg-slate-900 text-white", accent:"bg-blue-600 text-white", warning:"bg-amber-500 text-white" } as const;
  return <span className={`px-2 py-0.5 rounded-full text-[12px] font-semibold ${toneMap[tone]}`}>{children}</span>;
}
function Modal({open,onClose,title,children}:{open:boolean;onClose:()=>void;title:string;children:React.ReactNode}) {
  if(!open) return null;
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-3">
      <div className="w-[min(640px,96vw)] rounded-2xl bg-white shadow-xl overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <div className="font-semibold">{title}</div>
          <button className="h-8 px-3 rounded-lg border" onClick={onClose}>닫기</button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}

// ── 충전비 계산 모달
function CostModal({open,onClose}:{open:boolean;onClose:()=>void}) {
  const [monthKm,setMonthKm]=useState(800);
  const [elecPrice,setElecPrice]=useState(280);
  const [gasPrice,setGasPrice]=useState(1650);
  const [gasEff,setGasEff]=useState(12);
  const [modelId,setModelId]=useState(EV_MODELS[0].id);

  const model = useMemo(()=>EV_MODELS.find(m=>m.id===modelId)!,[modelId]);
  const kWh = monthKm / (model.eff || 5.5);
  const evCost = Math.round(kWh * elecPrice);
  const gasCost = Math.round((monthKm / gasEff) * gasPrice);
  const savings = gasCost - evCost;

  return (
    <Modal open={open} onClose={onClose} title="충전비 계산(간단)">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-sm text-slate-600">월 주행거리(km)</span>
          <input type="number" className="h-10 px-3 border rounded-xl" value={monthKm} onChange={e=>setMonthKm(+e.target.value)} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-sm text-slate-600">EV 모델</span>
          <select className="h-10 px-3 border rounded-xl" value={modelId} onChange={e=>setModelId(e.target.value)}>
            {EV_MODELS.map(m=><option key={m.id} value={m.id}>{m.name} (효율 {m.eff} km/kWh)</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-sm text-slate-600">전기요금(₩/kWh)</span>
          <input type="number" className="h-10 px-3 border rounded-xl" value={elecPrice} onChange={e=>setElecPrice(+e.target.value)} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-sm text-slate-600">휘발유가(₩/L)</span>
          <input type="number" className="h-10 px-3 border rounded-xl" value={gasPrice} onChange={e=>setGasPrice(+e.target.value)} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-sm text-slate-600">가솔린 연비(km/L)</span>
          <input type="number" className="h-10 px-3 border rounded-xl" value={gasEff} onChange={e=>setGasEff(+e.target.value)} />
        </label>
      </div>
      <div className="mt-4 rounded-xl bg-slate-50 p-4 text-[15px]">
        <div className="flex justify-between"><span>EV 월 충전량</span><b>{Math.round(kWh).toLocaleString()} kWh</b></div>
        <div className="flex justify-between mt-1"><span>EV 월 충전비</span><b>₩{evCost.toLocaleString()}</b></div>
        <div className="flex justify-between mt-1"><span>가솔린 월 유류비</span><b>₩{gasCost.toLocaleString()}</b></div>
        <div className="flex justify-between mt-2 text-emerald-700"><span>월 절감액</span><b>₩{savings.toLocaleString()}</b></div>
      </div>
      <p className="text-xs text-slate-500 mt-2">※ 실제 값은 요금제/주행조건에 따라 달라질 수 있습니다.</p>
    </Modal>
  );
}

// ── 보조금 모달
function SubsidyModal({open,onClose}:{open:boolean;onClose:()=>void}) {
  const [region,setRegion]=useState<keyof typeof SUBSIDY.local>("서울");
  const total = SUBSIDY.national + SUBSIDY.local[region];
  return (
    <Modal open={open} onClose={onClose} title="보조금 보기(예상)">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-sm text-slate-600">지역 선택</span>
          <select className="h-10 px-3 border rounded-xl" value={region} onChange={e=>setRegion(e.target.value as any)}>
            {Object.keys(SUBSIDY.local).map(k=><option key={k} value={k}>{k}</option>)}
          </select>
        </label>
        <div className="rounded-xl bg-slate-50 p-4">
          <div className="flex justify-between text-[15px]"><span>국고</span><b>₩{SUBSIDY.national.toLocaleString()}</b></div>
          <div className="flex justify-between text-[15px] mt-1"><span>지자체</span><b>₩{SUBSIDY.local[region].toLocaleString()}</b></div>
          <hr className="my-2" />
          <div className="flex justify-between text-[15px]"><span>합계(예상)</span><b>₩{total.toLocaleString()}</b></div>
        </div>
      </div>
      <p className="text-xs text-slate-500 mt-2">※ 최신 공고 확인이 필요합니다(차종·예산에 따라 상이).</p>
    </Modal>
  );
}

// ── 메인 카드 (봇 메시지로 사용)
export default function EvInfoCard({ onOpenHub, onTrack }: { onOpenHub: () => void; onTrack?: (e:string,p?:any)=>void }) {
  const [openCost,setOpenCost]=useState(false);
  const [openSubsidy,setOpenSubsidy]=useState(false);

  return (
    <div className="rounded-3xl border border-slate-200 bg-white p-5">
      

      <div className="flex flex-wrap gap-2 mb-4">
        <Chip onClick={()=>{onTrack?.('ev_chip_click',{chip:'cost'}); setOpenCost(true);}}>충전비 계산</Chip>
        <Chip onClick={()=>{onTrack?.('ev_chip_click',{chip:'subsidy'}); setOpenSubsidy(true);}}>보조금 보기</Chip>
      </div>

      <div className="space-y-3">
        {EV_MODELS.map(m=>(
          <div key={m.id} className="rounded-2xl border border-slate-200 p-4">
            <div className="flex items-center gap-2 mb-1">
              <div className="text-lg font-semibold">{m.name}</div>
              {(m.badges||[]).map(b=><Tag key={b} tone={b==='EV'?'accent':b==='혜택'?'warning':'default'}>{b}</Tag>)}
            </div>
            <div className="text-slate-600 text-sm">{m.segment} · 주행거리 {m.range}km</div>
            <div className="text-slate-900 font-extrabold text-xl mt-2">₩{m.price.toLocaleString()}부터</div>
          </div>
        ))}
      </div>

      <div className="mt-4">
        <button className="w-full h-12 text-base font-semibold rounded-2xl bg-slate-900 text-white" onClick={()=>{onTrack?.('ev_card_cta_click'); onOpenHub();}}>
          전체 EV 모델 보기
        </button>
        <div className="mt-2 text-center text-slate-500 text-[13px]">세부 비교/견적은 모델 허브에서 확인하세요.</div>
      </div>

      <CostModal open={openCost} onClose={()=>setOpenCost(false)}/>
      <SubsidyModal open={openSubsidy} onClose={()=>setOpenSubsidy(false)}/>
    </div>
  );
}
