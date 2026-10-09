// Canonical JSON that is byte-identical to the env lane's submission.py `canonical()`:
//   json.dumps(v, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False)
// for the value domain an arena request uses: objects, arrays, strings, booleans, null and safe integers.
// Floats are refused, not approximated: Python prints `1.0` where JS prints `1`, so the two digests would
// silently diverge. Callers treat submission.py's `request_sha256` as authoritative and use this module to
// (a) cross-check it and (b) produce the exact POST bytes whose sha256 must equal the approved digest.
import { createHash } from 'node:crypto';

export class CanonicalError extends Error {}

/** Python sorts str keys by code point; JS's default sort uses UTF-16 units. Equal for BMP, not beyond. */
function compareCodePoints(a, b) {
  const A = Array.from(a, c => c.codePointAt(0));
  const B = Array.from(b, c => c.codePointAt(0));
  for (let i = 0; i < Math.min(A.length, B.length); i++) if (A[i] !== B[i]) return A[i] - B[i];
  return A.length - B.length;
}

// JSON.stringify already matches Python for `"`, `\\`, \b \f \n \r \t and \u00XX controls (lowercase hex).
// ensure_ascii additionally escapes everything outside 0x20..0x7e, one UTF-16 unit at a time.
const encodeString = s => JSON.stringify(s).replace(/[\u007f-￿]/g,
  c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));

function encode(value, depth) {
  if (depth > 64) throw new CanonicalError('canonical JSON nesting exceeds 64 levels');
  if (value === null) return 'null';
  if (value === true) return 'true';
  if (value === false) return 'false';
  if (typeof value === 'string') return encodeString(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new CanonicalError('canonical JSON accepts only safe integers (no floats, NaN or Infinity)');
    return String(value === 0 ? 0 : value);
  }
  if (Array.isArray(value)) return '[' + value.map(v => encode(v, depth + 1)).join(',') + ']';
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const keys = Object.keys(value).sort(compareCodePoints);
    return '{' + keys.map(k => {
      if (value[k] === undefined) throw new CanonicalError('canonical JSON cannot encode undefined');
      return encodeString(k) + ':' + encode(value[k], depth + 1);
    }).join(',') + '}';
  }
  throw new CanonicalError(`canonical JSON cannot encode ${typeof value}`);
}

export const canonicalJson = value => encode(value, 0);
export const sha256Hex = bytes => createHash('sha256').update(bytes).digest('hex');
export const canonicalDigest = value => sha256Hex(Buffer.from(canonicalJson(value), 'utf8'));
export const SHA256_RE = /^[0-9a-f]{64}$/;
