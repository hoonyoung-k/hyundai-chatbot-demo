// src/logic/overrides.ts
export type R3Override = { query: string; rating: 'Good'|'Fair'|'Bad'; reason?: string };

const norm = (s?: string) =>
  (s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

let _map: Map<string, R3Override> | null = null;

export async function loadOverrides(): Promise<Map<string, R3Override>> {
  if (_map && _map.size > 0) return _map;
  // CSV를 텍스트로 읽고 헤더 파싱
  const res = await fetch('/r3_overrides.csv', { cache: 'no-store' });
  if (!res.ok) { _map = new Map(); return _map; }
  const text = await res.text();
  const lines = text.replace(/\r/g,'').split('\n').filter(Boolean);
  const head = lines[0].split(',').map(h=>h.trim().toLowerCase());
  const qi = head.findIndex(h=>h==='query'); 
  const ri = head.findIndex(h=>h==='rating');
  const si = head.findIndex(h=>h==='reason');
  const map = new Map<string, R3Override>();
  for (const line of lines.slice(1)) {
    const cols = []; let cur=''; let q=false;
    for (const ch of line) {
      if (ch === '"'){ q=!q; continue; }
      if (ch === ',' && !q){ cols.push(cur); cur=''; continue; }
      cur += ch;
    }
    cols.push(cur);
    const query = (cols[qi]||'').trim();
    if (!query) continue;
    const rating = (cols[ri]||'').trim().toLowerCase();
    const reason = (si>=0 ? (cols[si]||'').trim() : '');
    const r: R3Override = { query, rating: rating.startsWith('g')?'Good':rating.startsWith('f')?'Fair':'Bad', reason };
    map.set(norm(query), r);
  }
  _map = map; 
  return _map;
}

export function keyQ(s: string){ return norm(s); }
