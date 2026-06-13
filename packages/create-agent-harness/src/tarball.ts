// SPDX-License-Identifier: MIT
//
// Tarball builder for IPFS publish.
//
// Produces a deterministic gzip-free tarball + a sha256 fingerprint that
// matches across CI runners. Deterministic-ness matters because:
//   - The witness manifest references the tarball by sha256
//   - Two runners must agree the same harness directory hashes to the same
//     tarball, so the witness signature verifies regardless of who built
//
// We avoid the `tar` npm package to keep create-agent-harness's install
// surface tiny. The format produced here is the bare POSIX ustar with
// fixed metadata (mode 0644, mtime 0, uid 0, gid 0, uname "", gname "")
// so the hash is reproducible.

import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, posix, relative, sep } from 'node:path';

const BLOCK_SIZE = 512;
const HEADER_FIELDS = {
  name: { offset: 0, length: 100 },
  mode: { offset: 100, length: 8 },
  uid: { offset: 108, length: 8 },
  gid: { offset: 116, length: 8 },
  size: { offset: 124, length: 12 },
  mtime: { offset: 136, length: 12 },
  checksum: { offset: 148, length: 8 },
  typeflag: { offset: 156, length: 1 },
  ustar: { offset: 257, length: 6 },
  ustar_version: { offset: 263, length: 2 },
} as const;

export interface TarballResult {
  /** Tarball bytes (uncompressed POSIX ustar). */
  bytes: Uint8Array;
  /** sha256 hex of the bytes. */
  sha256: string;
  /** Files included, posix paths relative to source root. */
  paths: string[];
}

function toPosix(p: string): string {
  return p.split(sep).join(posix.sep);
}

const SKIP_DIRS = new Set(['.git', 'node_modules', 'target', 'dist', '.cache']);

async function* walkFiles(root: string, current: string): AsyncGenerator<{ path: string; full: string }> {
  const entries = await readdir(current, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name)); // deterministic order
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const full = join(current, e.name);
    if (e.isDirectory()) {
      yield* walkFiles(root, full);
    } else if (e.isFile()) {
      yield { path: toPosix(relative(root, full)), full };
    }
  }
}

function octal(num: number, width: number): string {
  // Width includes the trailing space + NUL terminator standard ustar
  // expects for the numeric fields. Pad with leading zeros.
  return num.toString(8).padStart(width - 1, '0') + '\0';
}

function writeHeader(name: string, size: number): Uint8Array {
  const buf = new Uint8Array(BLOCK_SIZE);
  // name (truncated to 100 bytes if needed; longer names need GNU-style
  // extension headers which we don't support yet).
  const nameBytes = new TextEncoder().encode(name).slice(0, HEADER_FIELDS.name.length);
  buf.set(nameBytes, HEADER_FIELDS.name.offset);
  // mode = 0644 in octal, zero-padded to 7 chars + NUL = 8 bytes
  buf.set(new TextEncoder().encode(octal(0o644, HEADER_FIELDS.mode.length)), HEADER_FIELDS.mode.offset);
  buf.set(new TextEncoder().encode(octal(0, HEADER_FIELDS.uid.length)), HEADER_FIELDS.uid.offset);
  buf.set(new TextEncoder().encode(octal(0, HEADER_FIELDS.gid.length)), HEADER_FIELDS.gid.offset);
  buf.set(new TextEncoder().encode(octal(size, HEADER_FIELDS.size.length)), HEADER_FIELDS.size.offset);
  buf.set(new TextEncoder().encode(octal(0, HEADER_FIELDS.mtime.length)), HEADER_FIELDS.mtime.offset);
  // typeflag '0' = regular file
  buf[HEADER_FIELDS.typeflag.offset] = 0x30;
  // ustar magic + version
  buf.set(new TextEncoder().encode('ustar\0'), HEADER_FIELDS.ustar.offset);
  buf.set(new TextEncoder().encode('00'), HEADER_FIELDS.ustar_version.offset);

  // Checksum: pre-fill the checksum field with spaces, sum every byte,
  // then write the octal sum back to the checksum field.
  for (let i = 0; i < HEADER_FIELDS.checksum.length; i++) {
    buf[HEADER_FIELDS.checksum.offset + i] = 0x20;
  }
  let sum = 0;
  for (let i = 0; i < BLOCK_SIZE; i++) sum += buf[i];
  // Field format: 6-octal-digit + NUL + space (8 bytes total)
  const csum = sum.toString(8).padStart(6, '0') + '\0 ';
  buf.set(new TextEncoder().encode(csum), HEADER_FIELDS.checksum.offset);
  return buf;
}

function padToBlock(data: Uint8Array): Uint8Array {
  const padded = Math.ceil(data.length / BLOCK_SIZE) * BLOCK_SIZE;
  if (padded === data.length) return data;
  const out = new Uint8Array(padded);
  out.set(data);
  return out;
}

/**
 * Build a tarball of the given directory. Deterministic: same input ->
 * same bytes -> same sha256, regardless of build host.
 */
export async function buildTarball(rootDir: string): Promise<TarballResult> {
  const blocks: Uint8Array[] = [];
  const paths: string[] = [];
  for await (const f of walkFiles(rootDir, rootDir)) {
    const contents = await readFile(f.full);
    const u8 = new Uint8Array(contents);
    const header = writeHeader(f.path, u8.length);
    blocks.push(header);
    blocks.push(padToBlock(u8));
    paths.push(f.path);
  }
  // Two zero blocks at the end terminate the archive.
  blocks.push(new Uint8Array(BLOCK_SIZE));
  blocks.push(new Uint8Array(BLOCK_SIZE));

  const total = blocks.reduce((a, b) => a + b.length, 0);
  const bytes = new Uint8Array(total);
  let off = 0;
  for (const b of blocks) { bytes.set(b, off); off += b.length; }

  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return { bytes, sha256, paths };
}
