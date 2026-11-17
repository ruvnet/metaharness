import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { queryGeospatial, geospatialHandlers, geospatialTools, type GeospatialArgs } from '../src/domains/geospatial.js';
const fixtures = JSON.parse(readFileSync(new URL('../data/geospatial/parity-fixtures.json', import.meta.url), 'utf8')) as {name:string;args:GeospatialArgs;expected:unknown}[];
const fixed = () => new Date('2026-11-17T00:00:00.000Z');
describe('static geospatial upstream fixtures',()=>{
  for(const [i,f] of fixtures.entries()) it(`${i} ${f.name} ${JSON.stringify(f.args)}`,()=>{
    expect(queryGeospatial(f.name,f.args,fixed)).toEqual(f.expected);
  });
  it('exports the exact twelve upstream names and schemas',()=>{
    expect(Object.keys(geospatialHandlers).sort()).toEqual(geospatialTools.map(t=>t.name).sort());
    expect(geospatialTools).toHaveLength(12);
  });
  it('does not leak mutable snapshot state',()=>{
    const r=queryGeospatial('intel_military_bases',{},fixed);
    (r.bases as Record<string,unknown>[])[0]!.name='corrupted';
    expect(queryGeospatial('intel_military_bases',{},fixed)).toEqual(fixtures[0]!.expected);
  });
  it('rejects unknown tool names',()=>expect(()=>queryGeospatial('intel_missing')).toThrow());
});
