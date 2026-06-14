// SPDX-License-Identifier: MIT
//
// Client-side zipping. Everything runs in the browser — no server touches the
// generated files. JSZip builds the archive, and a Blob + object URL triggers
// the download. A deterministic date is used so the same inputs produce the
// same bytes (helps the witness/provenance story downstream).

import JSZip from 'jszip';
import type { GenFile } from './types';

const FIXED_DATE = new Date('2020-01-01T00:00:00Z');

/** Build a zip Blob from a flat list of files. */
export async function zipFiles(files: GenFile[]): Promise<Blob> {
  const zip = new JSZip();
  for (const f of files) {
    zip.file(f.path, f.content, { date: FIXED_DATE });
  }
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

/** Build a zip with every file nested under a root directory. */
export async function zipFilesUnder(root: string, files: GenFile[]): Promise<Blob> {
  return zipFiles(files.map((f) => ({ path: `${root}/${f.path}`, content: f.content })));
}

/** Trigger a browser download for a Blob. No-op safe outside the DOM. */
export function downloadBlob(blob: Blob, filename: string): void {
  if (typeof document === 'undefined') return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick so the click has time to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Total uncompressed byte size of a file list (for the UI size hint). */
export function totalBytes(files: GenFile[]): number {
  return files.reduce((n, f) => n + new TextEncoder().encode(f.content).length, 0);
}
