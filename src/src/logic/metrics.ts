// src/logic/metrics.ts
type Sample = { v: number };

export const metrics = {
  ttfb: [] as Sample[],       // 첫 토큰까지
  totalMs: [] as Sample[],    // 전체 응답
  good: 0,
  bad: 0,
};

export function recTTFB(ms: number) {
  metrics.ttfb.push({ v: ms });
}

export function recTotal(ms: number) {
  metrics.totalMs.push({ v: ms });
}

export function recGood() {
  metrics.good += 1;
}

export function recBad() {
  metrics.bad += 1;
}

function p50(arr: Sample[]) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a.v - b.v).map(x => x.v);
  const i = Math.floor(s.length * 0.5);
  return s[i];
}

export function snapshot() {
  const total = metrics.good + metrics.bad || 1;
  return {
    ttfb_p50: p50(metrics.ttfb),
    total_p50: p50(metrics.totalMs),
    good_rate: +(metrics.good / total * 100).toFixed(1),
    samples: total,
  };
}
