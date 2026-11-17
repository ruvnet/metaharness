/** Deterministic spherical geofencing. Not a routing or billable-distance API. */
export interface GeoPoint { latitude: number; longitude: number }
export interface GeoBounds { south: number; west: number; north: number; east: number }
export interface GeoKernel {
  readonly backend: 'typescript' | 'wasm';
  distanceKm(a: GeoPoint, b: GeoPoint): number;
  contains(point: GeoPoint, bounds: GeoBounds): boolean;
}
type RawKernel = {
  distanceKm(a: number, b: number, c: number, d: number): number;
  containsBBox(a: number, b: number, c: number, d: number, e: number, f: number): number;
};
function range(n: number, min: number, max: number, label: string): void {
  if (!Number.isFinite(n) || n < min || n > max) throw new RangeError(`${label} must be finite in [${min}, ${max}]`);
}
function point(p: GeoPoint): void {
  range(p.latitude, -90, 90, 'latitude'); range(p.longitude, -180, 180, 'longitude');
}
function bounds(b: GeoBounds): void {
  range(b.south, -90, 90, 'south'); range(b.north, -90, 90, 'north');
  range(b.west, -180, 180, 'west'); range(b.east, -180, 180, 'east');
  if (b.south > b.north) throw new RangeError('south must not exceed north');
}
function longitudeInside(lon: number, west: number, east: number): boolean {
  return west <= east ? lon >= west && lon <= east : lon >= west || lon <= east;
}
const ts: RawKernel = {
  distanceKm(lat1, lon1, lat2, lon2) {
    const rad = Math.PI / 180;
    const a = Math.sin((lat2 - lat1) * rad / 2) ** 2
      + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin((lon2 - lon1) * rad / 2) ** 2;
    return 6371.0088 * 2 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, a))));
  },
  containsBBox(lat, lon, south, west, north, east) {
    return Number(lat >= south && lat <= north && (longitudeInside(lon, west, east)
      || (Math.abs(lon) === 180 && longitudeInside(-lon, west, east))));
  },
};
function wrap(raw: RawKernel, backend: GeoKernel['backend']): GeoKernel {
  return Object.freeze({ backend,
    distanceKm(a: GeoPoint, b: GeoPoint) { point(a); point(b); return raw.distanceKm(a.latitude, a.longitude, b.latitude, b.longitude); },
    contains(p: GeoPoint, b: GeoBounds) { point(p); bounds(b); return raw.containsBBox(p.latitude, p.longitude, b.south, b.west, b.north, b.east) === 1; },
  });
}
/** Explicit portable fallback: no hidden download, compilation or filesystem read. */
export function createGeoKernel(): GeoKernel { return wrap(ts, 'typescript'); }
/** Load trusted, bundled bytes only. Never compile an untrusted remote module. */
export async function loadGeoWasm(bytes: Uint8Array): Promise<GeoKernel> {
  const module = await WebAssembly.compile(Uint8Array.from(bytes));
  if (WebAssembly.Module.imports(module).length) throw new Error('Geo WASM must not import host capabilities');
  const instance = await WebAssembly.instantiate(module, {});
  const raw = instance.exports as unknown as RawKernel;
  if (typeof raw.distanceKm !== 'function' || typeof raw.containsBBox !== 'function') throw new Error('Invalid Geo WASM exports');
  return wrap(raw, 'wasm');
}
