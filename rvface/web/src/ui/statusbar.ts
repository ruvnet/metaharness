/**
 * Status strip: engine/backend badges, live FPS + latency readout, and a
 * scrolling log (weight download progress, backend init messages).
 */

import type { BackendKind, EngineKind } from '../engine';
import { formatBytes, type WeightProgress } from '../weights';

export class StatusBar {
  private readonly badgeBackend: HTMLElement;
  private readonly badgeEngine: HTMLElement;
  private readonly metrics: HTMLElement;
  private readonly logEl: HTMLElement;
  private readonly progressLines = new Map<string, HTMLElement>();

  constructor(root: HTMLElement) {
    root.innerHTML = `
      <div class="status-row">
        <span class="badge" data-role="backend">backend: —</span>
        <span class="badge" data-role="engine">engine: —</span>
        <span class="metrics" data-role="metrics"></span>
      </div>
      <div class="status-log" data-role="log" aria-live="polite"></div>
    `;
    this.badgeBackend = root.querySelector('[data-role="backend"]')!;
    this.badgeEngine = root.querySelector('[data-role="engine"]')!;
    this.metrics = root.querySelector('[data-role="metrics"]')!;
    this.logEl = root.querySelector('[data-role="log"]')!;
  }

  setEngine(backend: BackendKind | null, kind: EngineKind | null): void {
    this.badgeBackend.textContent = `backend: ${backend ?? '—'}`;
    this.badgeBackend.classList.toggle('badge-gpu', backend === 'webgpu');
    this.badgeEngine.textContent = `engine: ${kind === 'mock' ? 'MOCK' : (kind ?? '—')}`;
    this.badgeEngine.classList.toggle('badge-mock', kind === 'mock');
    this.badgeEngine.classList.toggle('badge-wasm', kind === 'wasm');
  }

  /** Live per-frame readout during webcam mode; pass null to clear. */
  setFrameMetrics(m: { latencyMs: number; fps: number } | null): void {
    this.metrics.textContent = m
      ? `${m.latencyMs.toFixed(1)} ms / frame · ${m.fps.toFixed(1)} FPS`
      : '';
  }

  log(msg: string, level: 'info' | 'warn' | 'error' = 'info'): void {
    const line = document.createElement('div');
    line.className = `log-line log-${level}`;
    const t = new Date();
    const stamp = t.toTimeString().slice(0, 8);
    line.textContent = `[${stamp}] ${msg}`;
    this.appendLine(line);
  }

  /** Weight download progress — one updating line per file. */
  weightProgress(p: WeightProgress): void {
    let line = this.progressLines.get(p.name);
    if (!line) {
      line = document.createElement('div');
      line.className = 'log-line log-progress';
      this.progressLines.set(p.name, line);
      this.appendLine(line);
    }
    const pct = p.total ? ` (${Math.round((p.received / p.total) * 100)}%)` : '';
    const total = p.total ? ` / ${formatBytes(p.total)}` : '';
    line.textContent = `weights: ${p.name} ${formatBytes(p.received)}${total}${pct}`;
  }

  private appendLine(line: HTMLElement): void {
    this.logEl.appendChild(line);
    while (this.logEl.childElementCount > 200) this.logEl.firstElementChild!.remove();
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }
}
