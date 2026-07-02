/**
 * Pixel access helpers. `FrameGrabber` owns one offscreen canvas and hands
 * out RGBA bytes for images or video frames — the canvas (and its 2D
 * context) is reused across webcam frames to avoid per-frame GC pressure
 * (ADR-0005: video -> offscreen canvas -> getImageData -> Uint8Array).
 */

export interface Frame {
  rgba: Uint8Array;
  width: number;
  height: number;
}

/** Cap analysis resolution; larger sources are downscaled into the grab. */
const MAX_DIM = 1280;

export class FrameGrabber {
  private readonly canvas = document.createElement('canvas');
  private readonly ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;

  /** Draw `source` into the reusable canvas and return its RGBA bytes. */
  grab(source: CanvasImageSource, srcWidth: number, srcHeight: number): Frame {
    const scale = Math.min(1, MAX_DIM / Math.max(srcWidth, srcHeight));
    const w = Math.max(1, Math.round(srcWidth * scale));
    const h = Math.max(1, Math.round(srcHeight * scale));
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
    this.ctx.drawImage(source, 0, 0, w, h);
    const data = this.ctx.getImageData(0, 0, w, h);
    return {
      rgba: new Uint8Array(data.data.buffer, data.data.byteOffset, data.data.byteLength),
      width: w,
      height: h,
    };
  }
}

/** Decode an image File/Blob into an ImageBitmap. */
export async function decodeImageFile(file: Blob): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file);
  } catch {
    throw new Error(`could not decode image (${file.type || 'unknown type'})`);
  }
}
