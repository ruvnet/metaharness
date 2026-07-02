/**
 * Image analysis pane: drop/pick an image or run the webcam; results are
 * drawn onto a canvas overlay (boxes, landmarks, pose gizmo).
 */

import type { FaceResult, RvFaceEngine } from '../engine';
import { drawFaces } from './overlay';
import { makeDropZone } from './dropzone';
import { decodeImageFile, FrameGrabber } from './frame';
import type { StatusBar } from './statusbar';

const MAX_FACES = 8;

export class AnalyzePane {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly video: HTMLVideoElement;
  private readonly camButton: HTMLButtonElement;
  private readonly info: HTMLElement;
  private readonly hint: HTMLElement;
  private readonly grabber = new FrameGrabber();

  private stream: MediaStream | null = null;
  private rafId = 0;
  private lastFrameTime = 0;
  private fpsEma = 0;
  private lastImage: ImageBitmap | null = null;

  constructor(
    root: HTMLElement,
    private readonly getEngine: () => RvFaceEngine | null,
    private readonly status: StatusBar,
  ) {
    root.innerHTML = `
      <div class="pane-head">
        <h2>Analyze</h2>
        <button type="button" data-role="cam">Start webcam</button>
      </div>
      <div class="drop-zone" data-role="zone">
        <p class="dz-hint" data-role="hint">Drop an image here, click to pick a file,<br>or start the webcam.</p>
        <canvas data-role="view" hidden></canvas>
        <video data-role="video" playsinline muted hidden></video>
      </div>
      <div class="face-info mono" data-role="info"></div>
    `;
    const zone = root.querySelector<HTMLElement>('[data-role="zone"]')!;
    this.canvas = root.querySelector('[data-role="view"]')!;
    this.ctx = this.canvas.getContext('2d')!;
    this.video = root.querySelector('[data-role="video"]')!;
    this.camButton = root.querySelector('[data-role="cam"]')!;
    this.info = root.querySelector('[data-role="info"]')!;
    this.hint = root.querySelector('[data-role="hint"]')!;

    makeDropZone(zone, (file) => void this.analyzeFile(file));
    this.camButton.addEventListener('click', () => void this.toggleWebcam());
  }

  /** Re-run analysis of the last still image (e.g. after an engine switch). */
  async reanalyze(): Promise<void> {
    if (this.lastImage && !this.stream) await this.analyzeBitmap(this.lastImage);
  }

  private async analyzeFile(file: File): Promise<void> {
    await this.stopWebcam();
    try {
      const bitmap = await decodeImageFile(file);
      this.lastImage?.close();
      this.lastImage = bitmap;
      this.status.log(`analyzing ${file.name} (${bitmap.width}x${bitmap.height})`);
      await this.analyzeBitmap(bitmap);
    } catch (err) {
      this.status.log(String(err instanceof Error ? err.message : err), 'error');
    }
  }

  private async analyzeBitmap(bitmap: ImageBitmap): Promise<void> {
    const engine = this.getEngine();
    if (!engine) {
      this.status.log('engine not ready yet', 'warn');
      return;
    }
    const frame = this.grabber.grab(bitmap, bitmap.width, bitmap.height);
    const t0 = performance.now();
    const faces = await engine.analyze(frame.rgba, frame.width, frame.height, MAX_FACES);
    const latency = performance.now() - t0;

    this.showCanvas(frame.width, frame.height);
    this.ctx.drawImage(bitmap, 0, 0, frame.width, frame.height);
    drawFaces(this.ctx, faces);
    this.renderInfo(faces, latency);
    this.status.log(`analyze: ${faces.length} face(s) in ${latency.toFixed(1)} ms`);
  }

  private async toggleWebcam(): Promise<void> {
    if (this.stream) {
      await this.stopWebcam();
      return;
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false,
      });
    } catch (err) {
      this.status.log(`webcam unavailable: ${err instanceof Error ? err.message : err}`, 'error');
      return;
    }
    this.video.srcObject = this.stream;
    await this.video.play();
    this.camButton.textContent = 'Stop webcam';
    this.status.log(`webcam started (${this.video.videoWidth}x${this.video.videoHeight})`);
    this.fpsEma = 0;
    this.lastFrameTime = performance.now();
    this.rafId = requestAnimationFrame(() => void this.frameLoop());
  }

  async stopWebcam(): Promise<void> {
    if (!this.stream) return;
    cancelAnimationFrame(this.rafId);
    this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
    this.camButton.textContent = 'Start webcam';
    this.status.setFrameMetrics(null);
    this.status.log('webcam stopped');
  }

  /** One webcam iteration: grab -> analyze -> draw -> schedule next. */
  private async frameLoop(): Promise<void> {
    if (!this.stream) return;
    const engine = this.getEngine();
    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;

    if (engine && vw > 0 && vh > 0) {
      const frame = this.grabber.grab(this.video, vw, vh);
      const t0 = performance.now();
      let faces: FaceResult[] = [];
      try {
        faces = await engine.analyze(frame.rgba, frame.width, frame.height, MAX_FACES);
      } catch (err) {
        this.status.log(`analyze failed: ${err instanceof Error ? err.message : err}`, 'error');
        await this.stopWebcam();
        return;
      }
      const latency = performance.now() - t0;

      if (!this.stream) return; // stopped while awaiting
      this.showCanvas(frame.width, frame.height);
      this.ctx.drawImage(this.video, 0, 0, frame.width, frame.height);
      drawFaces(this.ctx, faces);
      this.renderInfo(faces, latency);

      const now = performance.now();
      const dt = now - this.lastFrameTime;
      this.lastFrameTime = now;
      const fps = 1000 / Math.max(dt, 1);
      this.fpsEma = this.fpsEma === 0 ? fps : this.fpsEma * 0.9 + fps * 0.1;
      this.status.setFrameMetrics({ latencyMs: latency, fps: this.fpsEma });
    }

    // Schedule the next frame only after this one fully finished, so a slow
    // engine backpressures the loop instead of piling up work.
    this.rafId = requestAnimationFrame(() => void this.frameLoop());
  }

  private showCanvas(w: number, h: number): void {
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
    this.canvas.hidden = false;
    this.hint.hidden = true;
  }

  private renderInfo(faces: FaceResult[], latencyMs: number): void {
    if (faces.length === 0) {
      this.info.textContent = `no faces · ${latencyMs.toFixed(1)} ms`;
      return;
    }
    const f = faces[0]!;
    const [x1, y1, x2, y2] = f.box;
    this.info.textContent =
      `${faces.length} face(s) · best score ${f.score.toFixed(3)} · ` +
      `box [${x1.toFixed(0)}, ${y1.toFixed(0)}, ${x2.toFixed(0)}, ${y2.toFixed(0)}] · ` +
      `yaw ${f.pose.yaw.toFixed(1)}° pitch ${f.pose.pitch.toFixed(1)}° roll ${f.pose.roll.toFixed(1)}° · ` +
      `${latencyMs.toFixed(1)} ms`;
  }
}
