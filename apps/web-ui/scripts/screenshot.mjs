// SPDX-License-Identifier: MIT
//
// Captures README screenshots from the *built* app via a real headless browser.
// Boots `vite preview` at root base, shoots desktop + mobile + the artifact
// view, writes PNGs into docs/web-ui/, then tears everything down. Run with:
//   npm run shot   (from apps/web-ui)

import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
const webUiRoot = path.resolve(here, '..');
const outDir = path.resolve(webUiRoot, '../../docs/web-ui');
const PORT = 4399;
const BASE = `http://localhost:${PORT}`;

async function waitForServer(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  throw new Error(`server did not come up at ${url}`);
}

async function main() {
  await mkdir(outDir, { recursive: true });

  const env = { ...process.env, VITE_BASE: '/' };
  const preview = spawn(
    'npx',
    ['vite', 'preview', '--port', String(PORT), '--strictPort'],
    { cwd: webUiRoot, env, stdio: 'inherit' },
  );

  try {
    await waitForServer(BASE);
    const browser = await chromium.launch();

    // Desktop — full harness view.
    const desktop = await browser.newPage({ viewport: { width: 1440, height: 1024 }, deviceScaleFactor: 2 });
    await desktop.goto(BASE, { waitUntil: 'networkidle' });
    await desktop.waitForSelector('text=Generated harness');
    await desktop.screenshot({ path: path.join(outDir, 'screenshot-desktop.png') });

    // Desktop — artifact (Claude skill) view.
    await desktop.getByRole('button', { name: 'Skill / Agent / Command' }).click();
    await desktop.waitForSelector('text=Artifact type');
    await desktop.screenshot({ path: path.join(outDir, 'screenshot-artifact.png') });

    // Desktop — Repo → Harness view.
    await desktop.getByRole('button', { name: 'Repo → Harness' }).click();
    await desktop.waitForSelector('text=Paste a GitHub repo');
    await desktop.screenshot({ path: path.join(outDir, 'screenshot-repo.png') });

    // Desktop — Verify view.
    await desktop.getByRole('button', { name: 'Verify', exact: true }).click();
    await desktop.waitForSelector('text=Verify a harness');
    await desktop.screenshot({ path: path.join(outDir, 'screenshot-verify.png') });
    await desktop.close();

    // Mobile — Pixel-ish viewport.
    const mobile = await browser.newPage({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 3, isMobile: true });
    await mobile.goto(BASE, { waitUntil: 'networkidle' });
    await mobile.waitForSelector('text=Generated harness');
    await mobile.screenshot({ path: path.join(outDir, 'screenshot-mobile.png'), fullPage: true });
    await mobile.close();

    await browser.close();
    console.log(`✓ screenshots written to ${outDir}`);
  } finally {
    preview.kill('SIGTERM');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
