// SPDX-License-Identifier: MIT
// ADR-142 (pilot): select a stratified 25-instance sample from SWE-bench Lite (test, 300)
// favouring FUNCTIONAL bug fixes (small patch, ≤2 files, 1-3 FAIL_TO_PASS) spread across repos —
// so the pilot tests LOGIC RESOLUTION, not Docker/environment wrestling. Data-driven + reproducible.
const pages = [];
for (const off of [0, 100, 200]) {
  const r = await fetch(`https://datasets-server.huggingface.co/rows?dataset=princeton-nlp/SWE-bench_Lite&config=default&split=test&offset=${off}&length=100`);
  pages.push(...(await r.json()).rows.map(x => x.row));
}
const inst = pages.map(x => ({
  instance_id: x.instance_id, repo: x.repo, base_commit: x.base_commit,
  patchChars: (x.patch || '').length,
  filesChanged: ((x.patch || '').match(/diff --git/g) || []).length,
  f2p: JSON.parse(x.FAIL_TO_PASS || '[]').length,
  p2p: JSON.parse(x.PASS_TO_PASS || '[]').length,
  problemChars: (x.problem_statement || '').length,
}));
// eligibility: functional fix — small, focused, has a clear failing test
const elig = inst.filter(i => i.filesChanged >= 1 && i.filesChanged <= 2 && i.patchChars <= 1500 && i.f2p >= 1 && i.f2p <= 3);
// stratify: round-robin across repos, smallest-patch first within each repo
const byRepo = {};
for (const i of elig.sort((a, b) => a.patchChars - b.patchChars)) (byRepo[i.repo] ||= []).push(i);
const repos = Object.keys(byRepo).sort((a, b) => byRepo[b].length - byRepo[a].length);
const pick = [];
let round = 0;
while (pick.length < 25) { let added = false; for (const r of repos) { if (byRepo[r][round]) { pick.push(byRepo[r][round]); added = true; if (pick.length >= 25) break; } } if (!added) break; round++; }
const dist = {};
for (const p of pick) dist[p.repo] = (dist[p.repo] || 0) + 1;
console.log('eligible (functional):', elig.length, 'of', inst.length, '| repos available:', repos.length);
console.log('selected 25 across repos:', JSON.stringify(dist));
console.log('patch chars range:', Math.min(...pick.map(p=>p.patchChars)), '-', Math.max(...pick.map(p=>p.patchChars)), '| avg files:', (pick.reduce((s,p)=>s+p.filesChanged,0)/pick.length).toFixed(1));
const fs = await import('node:fs');
fs.writeFileSync(new URL('./pilot-sample-25.json', import.meta.url), JSON.stringify({ dataset: 'princeton-nlp/SWE-bench_Lite', split: 'test', n: pick.length, criteria: 'filesChanged 1-2, patchChars<=1500, f2p 1-3; round-robin across repos, smallest-patch-first', distribution: dist, instances: pick }, null, 2));
console.log('saved pilot-sample-25.json');
