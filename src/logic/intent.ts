// src/logic/intent.ts
// 의도/엔티티 간단 파서 (룰 베이스)

export type IntentName =
  | "recommend_ev"
  | "find_service_center"
  | "build_quote"
  | "test_drive"
  | "faq_simple"
  | "ask_price"              // ★ 추가
  | "ask_warranty"           // ★ 추가
  | "find_charging_station"  // ★ 추가
  | "fallback";

export type Entities = {
  model?: string;
  fuel?: "EV" | "HEV" | "ICE";
  city?: string;
  segment?: "SUV" | "Sedan";
  budget?: string;
  kind?: "지점/대리점" | "드라이빙 라운지" | "서비스센터";
};

const CITY_REGEX = /(강남|분당|서초|성남|수원|잠실|종로|마포|용산|송파|일산|판교)/;
const MODEL_HINT = /(아이오닉\s?\d?|아반떼\s?N|아반떼n|아반테|아반떼|팰리세이드|펠리세이드|싼타페|산타페|코나|그랜저|그랜져|캐스퍼|스타리아|포터|투싼|투산|쏘나타|소나타|g70|g\s?70|g80|g\s?80|g90|g\s?90|gv60|gv\s?60|gv70|gv\s?70|gv80|gv\s?80)/i;

// ★ 추가: 도메인 키워드
const PRICE_RX    = /(가격|비용|얼마|금액|가격표|할인|혜택가)/i;
const WARRANTY_RX = /(보증|AS|A\/S|워런티|보장|무상수리)/i;
const CHARGE_RX   = /(충전소|충전\s*위치|급속\s*충전|완속\s*충전|충전\s*가능)/i;

export function parseIntent(text: string, normalizedText?: string): { intent: IntentName; entities: Entities } {
  const q = (text || "").trim();
  const source = (normalizedText || q).trim();
  const s = source.toLowerCase();
  const entities: Entities = {};

  // fuel / segment / model 후보
  if (/(ev|전기차)/i.test(source)) entities.fuel = "EV";
  if (/hev|하이브리드/i.test(source)) entities.fuel = "HEV";
  if (/suv/i.test(source)) entities.segment = "SUV";
  if (/세단|sedan/i.test(source)) entities.segment = "Sedan";
  const m = source.match(MODEL_HINT);
  if (m) entities.model = m[0].replace(/\s+/g, '');

  // city 추출
  const c = source.match(CITY_REGEX);
  if (c) entities.city = c[1];

  // 네트워크 kind
  if (/드라이빙\s*라운지|시승/i.test(source)) entities.kind = "드라이빙 라운지";
  else if (/지점|대리점/i.test(source)) entities.kind = "지점/대리점";
  else if (/서비스센터|블루핸즈|센터/i.test(source)) entities.kind = "서비스센터";

  // ====== 인텐트 라우팅 (우선순위 중요) ======

  // 1) 가격
  if (PRICE_RX.test(source)) {
    return { intent: "ask_price", entities };
  }

  // 2) 보증
  if (WARRANTY_RX.test(source)) {
    return { intent: "ask_warranty", entities };
  }

  // 3) 충전소 (서비스센터보다 먼저 평가해야 혼선 없음)
  if (CHARGE_RX.test(source)) {
    return { intent: "find_charging_station", entities };
  }

  // 4) EV 추천
  if (/전기차|ev 추천|ev.*추천/i.test(source) || (entities.fuel === "EV" && /추천|알려줘|뭐가/i.test(source))) {
    return { intent: "recommend_ev", entities };
  }

  // 5) 네트워크(센터/지점/라운지/시승)
  if (/서비스센터|블루핸즈|근처|가까운|드라이빙\s*라운지|지점|대리점|시승/i.test(source)) {
    return { intent: "find_service_center", entities };
  }

  // 선택 보강: 센터 키워드 강화를 원하면 이 한 줄만 교체
  if (/(서비스센터|블루핸즈|정비소|as\s*센터|센터\s*찾|근처\s*센터|가까운\s*센터)/i.test(source)) {
    return { intent: "find_service_center", entities };
  }


  // 6) 빌더/견적
  if (/내\s*차\s*만들기|옵션|견적|빌더|구성/i.test(source)) {
    return { intent: "build_quote", entities };
  }

  // 7) FAQ
  if (/어떻게|방법|자주 묻는 질문|faq/i.test(source)) {
    return { intent: "faq_simple", entities };
  }

  // 8) 기본
  return { intent: "fallback", entities };
}
