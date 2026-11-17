import { readFile } from 'node:fs/promises';
import { describe, it, expect } from 'vitest';
import { createGeoKernel, loadGeoWasm } from '../src/geo.js';

const bytes = await readFile(new URL('../wasm/geo.wasm', import.meta.url));
const wasm = await loadGeoWasm(bytes);
const ts = createGeoKernel();
describe.each([ts, wasm])('geofencing ($backend)', (kernel) => {
  it('calculates known spherical distances, including antipodes', () => {
    const origin = { latitude: 0, longitude: 0 };
    expect(kernel.distanceKm(origin, origin)).toBe(0);
    expect(kernel.distanceKm(origin, { latitude: 0, longitude: 1 })).toBeCloseTo(111.19508, 4);
    expect(kernel.distanceKm(origin, { latitude: 0, longitude: 180 })).toBeCloseTo(20015.11444, 4);
  });
  it('handles inclusive bounds and antimeridian crossing', () => {
    const box = { south: -10, west: 170, north: 10, east: -170 };
    expect(kernel.contains({ latitude: 10, longitude: 170 }, box)).toBe(true);
    expect(kernel.contains({ latitude: 0, longitude: -175 }, box)).toBe(true);
    expect(kernel.contains({ latitude: 0, longitude: 0 }, box)).toBe(false);
    expect(kernel.contains({ latitude: 11, longitude: 180 }, box)).toBe(false);
    expect(kernel.contains({ latitude: 0, longitude: -180 }, { south: -1, west: 170, north: 1, east: 180 })).toBe(true);
    expect(kernel.contains({ latitude: 0, longitude: 180 }, { south: -1, west: -180, north: 1, east: -170 })).toBe(true);
  });
  it('rejects nonfinite, out-of-range and reversed latitude bounds', () => {
    for (const latitude of [NaN, Infinity, 91, -91]) {
      expect(() => kernel.distanceKm({ latitude, longitude: 0 }, { latitude: 0, longitude: 0 })).toThrow(RangeError);
    }
    expect(() => kernel.contains({ latitude: 0, longitude: 181 }, { south: -1, west: 0, north: 1, east: 1 })).toThrow(RangeError);
    expect(() => kernel.contains({ latitude: 0, longitude: 0 }, { south: 1, west: 0, north: -1, east: 1 })).toThrow(RangeError);
  });
});
it('matches TS across deterministic globally distributed inputs', () => {
  for (let i = 0; i < 100; i++) {
    const a = { latitude: (i * 17 % 180) - 90, longitude: (i * 31 % 360) - 180 };
    const b = { latitude: (i * 29 % 180) - 90, longitude: (i * 43 % 360) - 180 };
    expect(wasm.distanceKm(a, b)).toBeCloseTo(ts.distanceKm(a, b), 7);
    const box = { south: -45, north: 45, west: i % 2 ? -80 : 170, east: i % 2 ? 80 : -170 };
    expect(wasm.contains(a, box)).toBe(ts.contains(a, box));
  }
});
it('rejects invalid bytes and incorrect module exports', async () => {
  await expect(loadGeoWasm(new Uint8Array([0, 1, 2]))).rejects.toThrow();
  await expect(loadGeoWasm(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]))).rejects.toThrow('Invalid Geo WASM exports');
});
