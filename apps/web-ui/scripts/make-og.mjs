#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// Render the social/OG card (1200x630 PNG) for link previews. Social scrapers
// (Twitter/Slack/Discord/LinkedIn/Facebook) do NOT render SVG, so we rasterise a
// branded HTML card with the Playwright chromium already used for e2e. Output:
// public/og.png (Vite copies public/ to the dist root → served at
// https://ruvnet.github.io/metaharness/og.png).
//
// Run: node scripts/make-og.mjs   (regenerate whenever the card copy changes)

import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'public');
mkdirSync(outDir, { recursive: true });
const out = join(outDir, 'og.png');

// Brand tokens mirror tailwind.config.js (ink-950 #0a0a0f, brand #7c5cff,
// glow #9d83ff, accent #22d3ee). Keep this card in sync with the hero copy.
const html = `<!doctype html><html><head><meta charset="utf-8"/>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html,body { width:1200px; height:630px; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, sans-serif;
    background:
      radial-gradient(900px 500px at 80% -10%, rgba(124,92,255,0.28), transparent 60%),
      radial-gradient(700px 500px at 0% 110%, rgba(34,211,238,0.12), transparent 55%),
      linear-gradient(160deg, #0a0a0f 0%, #13131f 100%);
    color:#fff; width:1200px; height:630px; position:relative; overflow:hidden;
    padding:72px 80px; display:flex; flex-direction:column; justify-content:space-between;
  }
  .top { display:flex; align-items:center; gap:14px; }
  .logo { width:46px; height:46px; border-radius:11px; background:#7c5cff;
    display:flex; align-items:center; justify-content:center; box-shadow:0 8px 40px -8px rgba(124,92,255,0.6); }
  .logo svg { width:30px; height:30px; }
  .eyebrow { font-size:21px; color:#9d83ff; font-weight:600; letter-spacing:0.02em; }
  h1 { font-size:84px; font-weight:800; letter-spacing:-0.03em; line-height:1.02; }
  h1 .g { color:#9d83ff; }
  .tag { font-size:33px; color:#c7c9d9; max-width:1000px; line-height:1.3; margin-top:20px; font-weight:400; }
  .chips { display:flex; gap:14px; flex-wrap:wrap; margin-top:34px; }
  .chip { font-size:23px; color:#e7e9f5; border:1.5px solid #33334d; background:rgba(26,26,40,0.6);
    padding:11px 20px; border-radius:999px; font-weight:500; }
  .chip b { color:#9d83ff; font-weight:600; }
  .foot { display:flex; align-items:center; justify-content:space-between; }
  .cmd { font-family:'SF Mono','Cascadia Code',Consolas,monospace; font-size:25px; color:#22d3ee;
    background:rgba(34,211,238,0.08); border:1px solid rgba(34,211,238,0.25); padding:10px 22px; border-radius:12px; }
  .hosts { font-size:21px; color:#7e8195; }
</style></head>
<body>
  <div>
    <div class="top">
      <div class="logo"><svg viewBox="0 0 32 32"><path d="M9 21l4-10 3 7 2-4 5 7z" fill="white"/></svg></div>
      <div class="eyebrow">Meta-harness · the agent harness supply chain</div>
    </div>
    <h1 style="margin-top:38px">MetaHarness <span class="g">Studio</span></h1>
    <div class="tag">Mint a custom AI agent harness from any repo — governed, branded, multi-host, npm-publishable.</div>
    <div class="chips">
      <div class="chip"><b>score</b> any repo</div>
      <div class="chip"><b>cost-optimal</b> model routing</div>
      <div class="chip">multi-host runtime</div>
      <div class="chip">witness-signed releases</div>
    </div>
  </div>
  <div class="foot">
    <div class="cmd">npx metaharness</div>
    <div class="hosts">Claude Code · Codex · pi.dev · Hermes · OpenClaw · RVM</div>
  </div>
</body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await page.setContent(html, { waitUntil: 'networkidle' });
await page.screenshot({ path: out, type: 'png', clip: { x: 0, y: 0, width: 1200, height: 630 } });
await browser.close();
console.log('[make-og] wrote', out);
