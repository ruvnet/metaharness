/**
 * 1:1 compare pane: two drop slots (A / B). When both hold an analyzed
 * face, the similarity score (0–100) is shown as a gauge with the
 * upstream threshold-75 same/different verdict.
 */

import { MATCH_THRESHOLD, type FaceResult, type RvFaceEngine } from '../engine';
import { drawFaces } from './overlay';
import { makeDropZone } from './dropzone';
import { decodeImageFile, FrameGrabber } from './frame';
import type { StatusBar } from './statusbar';

interface SlotState {
  face: FaceResult | null;
  latencyMs: number;
}

class CompareSlot {
  readonly state: SlotState = { face: null, latencyMs: 0 };
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly hint: HTMLElement;
  private readonly info: HTMLElement;
  private readonly grabber = new FrameGrabber();

  constructor(
    root: HTMLElement,
    private readonly label: string,
    private readonly getEngine: () => RvFaceEngine | null,
    private readonly status: StatusBar,
    private readonly onChange: () => void,
  ) {
    root.innerHTML = `
      <div class="slot-label">${label}</div>
      <div class="drop-zone drop-zone-slot" data-role="zone">
        <p class="dz-hint" data-role="hint">Drop image ${label}</p>
        <canvas data-role="view" hidden></canvas>
      </div>
      <div class="face-info mono" data-role="info"></div>
    `;
    const zone = root.querySelector<HTMLElement>('[data-role="zone"]')!;
    this.canvas = root.querySelector('[data-role="view"]')!;
    this.ctx = this.canvas.getContext('2d')!;
    this.hint = root.querySelector('[data-role="hint"]')!;
    this.info = root.querySelector('[data-role="info"]')!;
    makeDropZone(zone, (file) => void this.load(file));
  }

  private async load(file: File): Promise<void> {
    const engine = this.getEngine();
    if (!engine) {
      this.status.log('engine not ready yet', 'warn');
      return;
    }
    let bitmap: ImageBitmap;
    try {
      bitmap = await decodeImageFile(file);
    } catch (err) {
      this.status.log(String(err instanceof Error ? err.message : err), 'error');
      return;
    }

    const frame = this.grabber.grab(bitmap, bitmap.width, bitmap.height);
    const t0 = performance.now();
    const faces = await engine.analyze(frame.rgba, frame.width, frame.height, 1);
    this.state.latencyMs = performance.now() - t0;
    this.state.face = faces[0] ?? null;

    if (this.canvas.width !== frame.width) this.canvas.width = frame.width;
    if (this.canvas.height !== frame.height) this.canvas.height = frame.height;
    this.canvas.hidden = false;
    this.hint.hidden = true;
    this.ctx.drawImage(bitmap, 0, 0, frame.width, frame.height);
    drawFaces(this.ctx, faces);
    bitmap.close();

    if (this.state.face) {
      const [x1, y1, x2, y2] = this.state.face.box;
      const nLandmarks = this.state.face.landmarks.length / 2;
      this.info.textContent =
        `box [${x1.toFixed(0)}, ${y1.toFixed(0)}, ${x2.toFixed(0)}, ${y2.toFixed(0)}] · ` +
        `${nLandmarks} landmarks · ${this.state.latencyMs.toFixed(1)} ms`;
      this.status.log(
        `compare slot ${this.label}: face ready (${this.state.latencyMs.toFixed(1)} ms)`,
      );
    } else {
      this.info.textContent = `no face found · ${this.state.latencyMs.toFixed(1)} ms`;
      this.status.log(`compare slot ${this.label}: no face found`, 'warn');
    }
    this.onChange();
  }
}

export class ComparePane {
  private readonly slotA: CompareSlot;
  private readonly slotB: CompareSlot;
  private readonly gaugeArc: SVGPathElement;
  private readonly gaugeScore: HTMLElement;
  private readonly verdict: HTMLElement;

  constructor(
    root: HTMLElement,
    private readonly getEngine: () => RvFaceEngine | null,
    status: StatusBar,
  ) {
    root.innerHTML = `
      <div class="pane-head"><h2>1:1 Compare</h2></div>
      <div class="compare-grid">
        <div data-role="slot-a"></div>
        <div class="gauge-wrap">
          <svg viewBox="0 0 100 60" class="gauge" aria-hidden="true">
            <path class="gauge-track" d="M 10 55 A 40 40 0 0 1 90 55" />
            <path class="gauge-fill" data-role="arc" d="M 10 55 A 40 40 0 0 1 90 55"
                  pathLength="100" stroke-dasharray="0 100" />
          </svg>
          <div class="gauge-score mono" data-role="score">—</div>
          <div class="verdict" data-role="verdict">awaiting both faces</div>
          <div class="gauge-threshold mono">threshold ${MATCH_THRESHOLD}</div>
        </div>
        <div data-role="slot-b"></div>
      </div>
    `;
    const update = () => this.update();
    this.slotA = new CompareSlot(
      root.querySelector('[data-role="slot-a"]')!, 'A', getEngine, status, update,
    );
    this.slotB = new CompareSlot(
      root.querySelector('[data-role="slot-b"]')!, 'B', getEngine, status, update,
    );
    this.gaugeArc = root.querySelector('[data-role="arc"]')!;
    this.gaugeScore = root.querySelector('[data-role="score"]')!;
    this.verdict = root.querySelector('[data-role="verdict"]')!;
  }

  /** Recompute the gauge (also called when the engine changes). */
  update(): void {
    const engine = this.getEngine();
    const a = this.slotA.state.face;
    const b = this.slotB.state.face;
    if (!engine || !a || !b) {
      this.gaugeArc.setAttribute('stroke-dasharray', '0 100');
      this.gaugeScore.textContent = '—';
      this.verdict.textContent = a || b ? 'awaiting second face' : 'awaiting both faces';
      this.verdict.className = 'verdict';
      return;
    }
    const score = engine.similarity(a.embedding, b.embedding);
    const same = score > MATCH_THRESHOLD;
    this.gaugeArc.setAttribute('stroke-dasharray', `${score.toFixed(2)} 100`);
    this.gaugeArc.classList.toggle('gauge-same', same);
    this.gaugeArc.classList.toggle('gauge-diff', !same);
    this.gaugeScore.textContent = score.toFixed(1);
    this.verdict.textContent = same ? 'SAME PERSON' : 'DIFFERENT';
    this.verdict.className = `verdict ${same ? 'verdict-same' : 'verdict-diff'}`;
  }
}
