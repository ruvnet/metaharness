// Authored in AssemblyScript (TypeScript syntax); no native/Python runtime.
const RAD: f64 = Math.PI / 180.0;
const EARTH_KM: f64 = 6371.0088;

export function distanceKm(lat1: f64, lon1: f64, lat2: f64, lon2: f64): f64 {
  const dLat = (lat2 - lat1) * RAD;
  const dLon = (lon2 - lon1) * RAD;
  const a = Math.sin(dLat / 2.0) ** 2.0
    + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2.0) ** 2.0;
  return EARTH_KM * 2.0 * Math.asin(Math.sqrt(Math.min(1.0, Math.max(0.0, a))));
}

// west > east denotes a box crossing the antimeridian. Edges are inclusive.
export function containsBBox(lat: f64, lon: f64, south: f64, west: f64, north: f64, east: f64): i32 {
  if (lat < south || lat > north) return 0;
  const inside = west <= east ? lon >= west && lon <= east : lon >= west || lon <= east;
  // +180 and -180 represent the same meridian.
  if (inside) return 1;
  if (lon == 180.0) return (west <= east ? -180.0 >= west && -180.0 <= east : -180.0 >= west || -180.0 <= east) ? 1 : 0;
  if (lon == -180.0) return (west <= east ? 180.0 >= west && 180.0 <= east : 180.0 >= west || 180.0 <= east) ? 1 : 0;
  return 0;
}
