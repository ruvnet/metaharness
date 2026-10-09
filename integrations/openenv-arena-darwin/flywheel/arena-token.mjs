// HF token handling for the arena client. The token is read ONLY from the HF token file
//   ${HF_TOKEN_PATH:-${HF_HOME:-$HOME/.cache/huggingface}/token}
// (HF_TOKEN in the environment is deliberately ignored), held in a private class field, and only ever
// leaves this module as the value of an in-process `Authorization: Bearer` header. It never goes on a
// command line, into a file this code writes, a log, an error message or any returned object.
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';

const REDACTED = '[REDACTED]';

export class TokenError extends Error {}

/** Resolve the token file path exactly like AGENTS.md's shell expansion (minus the HF_TOKEN env branch). */
export function hfTokenPath(env = process.env) {
  if (env.HF_TOKEN_PATH) return env.HF_TOKEN_PATH;
  const hfHome = env.HF_HOME || join(env.HOME || homedir(), '.cache', 'huggingface');
  return join(hfHome, 'token');
}

/** Opaque holder: serialising, printing or inspecting it never shows the secret. */
export class HfToken {
  #value;
  constructor(value) { this.#value = value; Object.freeze(this); }
  authorizationHeader() { return 'Bearer ' + this.#value; }
  redact(text) { return redactText(text, [this.#value]); }
  toJSON() { return REDACTED; }
  toString() { return REDACTED; }
  [inspect.custom]() { return 'HfToken([REDACTED])'; }
}

/** Read and validate the token file. Error messages name the path, never any of the file's content. */
export function readHfToken({ env = process.env, path = hfTokenPath(env) } = {}) {
  let raw;
  try {
    const st = statSync(path);
    if (!st.isFile()) throw new TokenError('HF token path is not a regular file');
    if (st.size > 8192) throw new TokenError('HF token file is implausibly large');
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if (err instanceof TokenError) throw err;
    throw new TokenError(`HF token file unreadable at ${path} (${err?.code ?? 'error'}); no authenticated request was sent`);
  }
  const value = raw.trim();
  if (!value) throw new TokenError('HF token file is empty; no authenticated request was sent');
  // Printable ASCII only, no whitespace: anything else could split or inject HTTP headers.
  if (!/^hf_[\x21-\x7e]{4,4092}$/.test(value)) throw new TokenError('HF token file has an invalid format; no authenticated request was sent');
  return new HfToken(value);
}

/** Defensive redaction for anything that might be surfaced: known secrets plus generic token shapes. */
export function redactText(text, secrets = []) {
  let out = String(text ?? '');
  for (const s of secrets) if (typeof s === 'string' && s.length >= 4) out = out.split(s).join(REDACTED);
  return out
    .replace(/(authorization\s*[:=]\s*)("?)[^"\r\n,}]*/gi, `$1$2${REDACTED}`)
    .replace(/bearer\s+[^\s"',}]+/gi, `Bearer ${REDACTED}`)
    .replace(/hf_[A-Za-z0-9._-]{4,}/g, `hf_${REDACTED}`);
}
