import { createHash } from 'node:crypto';

export const BASELINE = {
  components: [
    { id: 'split', scope: 'invariant', content: { quoted: false } },
    { id: 'amount', scope: 'domain', content: { decimalComma: false } },
  ],
};
export const clone = (x) => structuredClone(x);
export const digest = (x) => createHash('sha256').update(JSON.stringify(x)).digest('hex');
export function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** Synthetic invoices; expected records are constructed before serialization. */
export function makeTasks(seed, count, partition) {
  const next = random(seed);
  return Array.from({ length: count }, (_, i) => {
    const quoted = partition === 'development' ? !!(i & 1) : next() < .5;
    const comma = partition === 'development' ? !!(i & 2) : next() < .5;
    const cents = 100 + Math.floor(next() * 99900);
    const label = partition + '_' + i + (quoted ? '|North "Lab"' : '_Lab');
    const money = (cents / 100).toFixed(2).replace('.', comma ? ',' : '.');
    const field = quoted ? '"' + label.replaceAll('"', '""') + '"' : label;
    return { id: partition + ':' + i, input: field + '|' + money + '|USD',
      expected: { label, cents, currency: 'USD' }, features: { quoted, comma } };
  });
}

function splitQuoted(text) {
  const parts = [];
  let field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '"') {
      if (quoted && text[i + 1] === '"') { field += '"'; i++; }
      else quoted = !quoted;
    } else if (text[i] === '|' && !quoted) { parts.push(field); field = ''; }
    else field += text[i];
  }
  if (quoted) throw new Error('Unterminated quoted field');
  return [...parts, field];
}

/** Components select real parser operations. No code eval or shell execution. */
export function execute(candidate, input) {
  const split = candidate.components.find(x => x.id === 'split')?.content;
  const amount = candidate.components.find(x => x.id === 'amount')?.content;
  const parts = split?.quoted ? splitQuoted(input) : input.split('|');
  if (parts.length !== 3) return null;
  const number = amount?.decimalComma ? parts[1].replace(',', '.') : parts[1];
  if (!/^\d+\.\d{2}$/.test(number)) return null;
  return { label: parts[0], cents: Math.round(Number(number) * 100), currency: parts[2] };
}

export function grade(candidate, tasks) {
  const failed = [];
  for (const task of tasks) {
    let actual;
    try { actual = execute(candidate, task.input); } catch { actual = null; }
    if (JSON.stringify(actual) !== JSON.stringify(task.expected)) failed.push(task.id);
  }
  return { total: tasks.length, passed: tasks.length - failed.length,
    score: (tasks.length - failed.length) / tasks.length, failed };
}

export function observations(candidate, tasks, failedIds = grade(candidate, tasks).failed) {
  const failed = new Set(failedIds);
  return candidate.components.flatMap(component => {
    const feature = component.id === 'split' ? 'quoted' : 'comma';
    const count = tasks.filter(x => failed.has(x.id) && x.features[feature]).length;
    return count ? [{ id: 'development:' + component.id, componentId: component.id,
      message: count + ' development rows containing ' + feature + ' fail exact extraction.' }] : [];
  });
}
