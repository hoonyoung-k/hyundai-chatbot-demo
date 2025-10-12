// src/logic/geo.ts
export type Coords = { lat: number; lng: number };

// Haversine (km)
export function haversine(a: Coords, b: Coords) {
  const R = 6371, toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export function extractFromKakaoUrl(url?: string): {
  lat?: number; lng?: number;
  placeId?: string;
  tmX?: number; tmY?: number;
} | null {
  if (!url) return null;

  // 1) link/to|map/장소명,lat,lng
  let m =
    url.match(/map\.kakao\.com\/link\/(?:to|map)\/[^,]+,([0-9.]+),([0-9.]+)/);
  if (m) return { lat: parseFloat(m[1]), lng: parseFloat(m[2]) };

  // 2) ...?lat=..&lng=..
  m = url.match(/[?&]lat=([0-9.]+).*?[&]lng=([0-9.]+)/);
  if (m) return { lat: parseFloat(m[1]), lng: parseFloat(m[2]) };

  // 3) ...?itemId=17767765&urlX=505697&urlY=1051845
  const id = url.match(/[?&]itemId=(\d+)/)?.[1];
  const x = url.match(/[?&]urlX=([0-9.]+)/)?.[1];
  const y = url.match(/[?&]urlY=([0-9.]+)/)?.[1];
  if (id) {
    const out: any = { placeId: id };
    if (x && y) {
      out.tmX = parseFloat(x);
      out.tmY = parseFloat(y);
    }
    return out;
  }

  return null;
}

export function withCoordsFromUrl<
  T extends { lat?: number; lng?: number; mapsUrl?: string; placeUrl?: string }
>(rows: T[]) {
  return rows.map((c) => {
    if (!c?.mapsUrl) return c;
    const info = extractFromKakaoUrl(c.mapsUrl);
    if (!info) return c;

    let next: any = { ...c };
    if (typeof info.lat === 'number' && typeof info.lng === 'number') {
      next.lat = info.lat;
      next.lng = info.lng;
    }
    if (info.placeId && !next.placeUrl) {
      next.placeUrl = `https://place.map.kakao.com/${info.placeId}`;
    }
    return next as T;
  });
}


export async function getGeoOnce(): Promise<Coords | null> {
  if (!("geolocation" in navigator)) return null;
  try {
    const status = await (navigator as any).permissions?.query?.({ name: "geolocation" });
    if (status && status.state === "denied") return null;
  } catch {}
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => resolve(null),
      { maximumAge: 15000, timeout: 7000, enableHighAccuracy: false }
    );
  });
}


// 거리 정렬(위경도만 계산) — TM만 있는 항목은 distance_km 유지/미표기
export function sortByDistance<
  T extends { lat?: number; lng?: number; distance_km?: number }
>(list: T[], me?: Coords | null) {
  if (!me) {
    return list
      .map((c) => ({ ...c, _dist: c.distance_km ?? 9e9 }))
      .sort((a, b) => (a._dist as number) - (b._dist as number))
      .map(({ _dist, ...rest }) => rest as T);
  }
  return list
    .map((c) => {
      const ok = typeof c.lat === "number" && typeof c.lng === "number";
      const _dist = ok ? haversine(me, { lat: c.lat!, lng: c.lng! }) : c.distance_km ?? 9e9;
      return { ...c, distance_km: _dist };
    })
    .sort((a, b) => (a.distance_km ?? 9e9) - (b.distance_km ?? 9e9));
}
