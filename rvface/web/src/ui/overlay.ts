/**
 * Canvas overlay drawing: detection boxes (score-labeled), 68 landmark
 * dots, and a 3-axis pose gizmo derived from yaw/pitch/roll.
 */

import type { FaceResult } from '../engine';

const BOX_COLOR = '#4ade80';
const LANDMARK_COLOR = '#38bdf8';
const AXIS_X = '#f87171'; // face "right" — red
const AXIS_Y = '#4ade80'; // face "down"  — green
const AXIS_Z = '#60a5fa'; // out of face  — blue

const DEG = Math.PI / 180;

/** Draw all faces onto `ctx` (which must already be sized to the image). */
export function drawFaces(ctx: CanvasRenderingContext2D, faces: FaceResult[]): void {
  for (const face of faces) {
    drawBox(ctx, face);
    drawLandmarks(ctx, face.landmarks);
    drawPoseGizmo(ctx, face);
  }
}

function drawBox(ctx: CanvasRenderingContext2D, face: FaceResult): void {
  const [x1, y1, x2, y2] = face.box;
  const w = x2 - x1;
  const h = y2 - y1;
  const lw = Math.max(1.5, Math.min(ctx.canvas.width, ctx.canvas.height) / 320);

  ctx.save();
  ctx.strokeStyle = BOX_COLOR;
  ctx.lineWidth = lw;
  ctx.strokeRect(x1, y1, w, h);

  // Score label, kept inside the canvas.
  const label = face.score.toFixed(3);
  const fontPx = Math.max(11, lw * 8);
  ctx.font = `${fontPx}px ui-monospace, monospace`;
  const tw = ctx.measureText(label).width;
  const pad = fontPx * 0.35;
  const ly = y1 - fontPx - pad * 2 >= 0 ? y1 - fontPx - pad * 2 : y1;
  ctx.fillStyle = 'rgba(6, 12, 8, 0.75)';
  ctx.fillRect(x1, ly, tw + pad * 2, fontPx + pad * 2);
  ctx.fillStyle = BOX_COLOR;
  ctx.fillText(label, x1 + pad, ly + fontPx + pad * 0.4);
  ctx.restore();
}

function drawLandmarks(ctx: CanvasRenderingContext2D, landmarks: Float32Array): void {
  const r = Math.max(1.25, Math.min(ctx.canvas.width, ctx.canvas.height) / 480);
  ctx.save();
  ctx.fillStyle = LANDMARK_COLOR;
  for (let i = 0; i + 1 < landmarks.length; i += 2) {
    ctx.beginPath();
    ctx.arc(landmarks[i]!, landmarks[i + 1]!, r, 0, 2 * Math.PI);
    ctx.fill();
  }
  ctx.restore();
}

/**
 * Pose axis gizmo: rotate the unit axes by R = Rz(roll) · Ry(yaw) · Rx(pitch)
 * and project orthographically onto the image plane, anchored at the box
 * center. Canvas y grows downward, hence the sign flips on projection.
 */
export function drawPoseGizmo(ctx: CanvasRenderingContext2D, face: FaceResult): void {
  const { yaw, pitch, roll } = face.pose;
  const [x1, y1, x2, y2] = face.box;
  const cx = (x1 + x2) / 2;
  const cy = (y1 + y2) / 2;
  const len = Math.min(x2 - x1, y2 - y1) * 0.4;

  const sy = Math.sin(yaw * DEG), cyaw = Math.cos(yaw * DEG);
  const sp = Math.sin(pitch * DEG), cp = Math.cos(pitch * DEG);
  const sr = Math.sin(roll * DEG), cr = Math.cos(roll * DEG);

  // Row-major R = Rz(roll) * Ry(yaw) * Rx(pitch).
  const r00 = cr * cyaw;
  const r01 = cr * sy * sp - sr * cp;
  const r02 = cr * sy * cp + sr * sp;
  const r10 = sr * cyaw;
  const r11 = sr * sy * sp + cr * cp;
  const r12 = sr * sy * cp - cr * sp;

  // Columns of R are the rotated basis vectors; take their (x, y) parts.
  const axes: Array<[number, number, string]> = [
    [r00, r10, AXIS_X],
    [r01, r11, AXIS_Y],
    [r02, r12, AXIS_Z],
  ];

  const lw = Math.max(1.5, Math.min(ctx.canvas.width, ctx.canvas.height) / 360);
  ctx.save();
  ctx.lineWidth = lw;
  ctx.lineCap = 'round';
  for (const [ax, ay, color] of axes) {
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + ax * len, cy - ay * len);
    ctx.stroke();
  }

  const fontPx = Math.max(10, lw * 7);
  ctx.font = `${fontPx}px ui-monospace, monospace`;
  ctx.fillStyle = 'rgba(226, 232, 240, 0.9)';
  const label = `y ${yaw.toFixed(0)}°  p ${pitch.toFixed(0)}°  r ${roll.toFixed(0)}°`;
  ctx.fillText(label, x1 + 2, Math.min(ctx.canvas.height - 4, y2 + fontPx + 2));
  ctx.restore();
}
