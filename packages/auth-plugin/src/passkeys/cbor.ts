/**
 * A bounded CBOR decoder for WebAuthn structures (plan §3.1, §8).
 *
 * WebAuthn encodes the attestation object and the COSE public key in CBOR
 * (RFC 8949). Only the subset a WebAuthn response can carry is decoded —
 * unsigned and negative integers, byte and text strings, arrays and maps, with
 * DEFINITE lengths only — and every structure is bounded: a depth limit and a
 * size limit, plus a refusal of every major type not listed. A hand-written
 * decoder is attack surface, so the bounds are the design, not hardening added
 * later: malformed input is refused, never half-decoded.
 *
 * @module
 */

/** The maximum nesting depth accepted. A WebAuthn COSE key is depth 2. */
export const MAX_CBOR_DEPTH = 4;

/** The maximum total input size accepted, in bytes. */
export const MAX_CBOR_BYTES = 4096;

/** A decoded CBOR value: an integer, byte string, text string, array, or map. */
export type CborValue =
  | number
  | Uint8Array
  | string
  | readonly CborValue[]
  | ReadonlyMap<CborValue, CborValue>;

/** One decoded item plus the number of bytes it consumed. */
export interface DecodedCbor {
  readonly value: CborValue;
  readonly bytesRead: number;
}

/** The reason a CBOR input was refused. Fixed codes, never input text. */
export type CborRefusal =
  | 'empty'
  | 'too-large'
  | 'too-deep'
  | 'truncated'
  | 'unsupported-type'
  | 'indefinite-length'
  | 'integer-overflow'
  | 'invalid-utf8'
  | 'trailing-bytes';

/** The outcome of a decode: the value, or why it was refused. */
export type CborOutcome =
  | { readonly ok: true; readonly value: CborValue; readonly bytesRead: number }
  | { readonly ok: false; readonly reason: CborRefusal };

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

/**
 * Reads an unsigned integer argument of `length` bytes at `offset`.
 *
 * `length` 0 means the value was carried in the initial byte (additional info
 * 0–23). An 8-byte argument is accepted only while it stays within
 * `Number.MAX_SAFE_INTEGER` — a larger integer cannot be represented exactly
 * and would silently round.
 */
function readUint(
  bytes: Uint8Array,
  offset: number,
  length: number,
): { ok: true; value: number; consumed: number } | { ok: false; reason: CborRefusal } {
  if (offset + length > bytes.length) {
    return { ok: false, reason: 'truncated' };
  }
  if (length === 0) {
    return { ok: true, value: 0, consumed: 0 };
  }
  let value = 0;
  for (let i = 0; i < length; i++) {
    value = value * 256 + bytes[offset + i]!;
    if (value > MAX_SAFE) {
      return { ok: false, reason: 'integer-overflow' };
    }
  }
  return { ok: true, value, consumed: length };
}

/** The additional-info length codes that are refused outright. */
function isRefusedAdditionalInfo(info: number): boolean {
  // 28–30 are reserved; 31 marks indefinite length, which this decoder refuses
  // outright — a streaming decoder is exactly the surface a bounded one exists
  // to avoid.
  return info >= 28;
}

/** The argument byte length an additional info selects; 0 means the value is the info itself. */
function argumentLength(info: number): number {
  if (info < 24) {
    return 0;
  }
  if (info === 24) {
    return 1;
  }
  if (info === 25) {
    return 2;
  }
  if (info === 26) {
    return 4;
  }
  return 8; // 27
}

/**
 * Decodes one CBOR item starting at `offset`, refusing anything outside the
 * supported subset.
 *
 * @param bytes - The input; its whole length must be within {@linkcode MAX_CBOR_BYTES}
 * @param offset - Where to start
 * @param depth - The current nesting depth
 * @returns The item and the bytes it consumed, or why it was refused
 */
export function decodeCborItem(
  bytes: Uint8Array,
  offset: number,
  depth: number,
): CborOutcome {
  if (bytes.length > MAX_CBOR_BYTES) {
    return { ok: false, reason: 'too-large' };
  }
  if (depth > MAX_CBOR_DEPTH) {
    return { ok: false, reason: 'too-deep' };
  }
  if (offset >= bytes.length) {
    return { ok: false, reason: 'truncated' };
  }
  const initial = bytes[offset]!;
  const major = initial >> 5;
  const info = initial & 0x1f;
  if (isRefusedAdditionalInfo(info)) {
    return { ok: false, reason: info === 31 ? 'indefinite-length' : 'unsupported-type' };
  }
  if (major === 6 || major === 7) {
    // Tags and floats/simple values: a WebAuthn attestation with `fmt: 'none'`
    // carries none of either, and accepting them would widen the surface the
    // bounds exist to keep small.
    return { ok: false, reason: 'unsupported-type' };
  }
  // For additional info 0–23 the argument IS the info itself; only 24–27 read
  // following bytes.
  const arg = info < 24
    ? { ok: true as const, value: info, consumed: 0 }
    : readUint(bytes, offset + 1, argumentLength(info));
  if (arg.ok === false) {
    return arg;
  }
  const payloadOffset = offset + 1 + arg.consumed;

  if (major === 0) {
    return { ok: true, value: arg.value, bytesRead: 1 + arg.consumed };
  }
  if (major === 1) {
    // Negative integers: -1 - n (RFC 8949 §3.1).
    return { ok: true, value: -1 - arg.value, bytesRead: 1 + arg.consumed };
  }
  if (major === 2 || major === 3) {
    if (payloadOffset + arg.value > bytes.length) {
      return { ok: false, reason: 'truncated' };
    }
    const slice = bytes.slice(payloadOffset, payloadOffset + arg.value);
    if (major === 2) {
      return { ok: true, value: slice, bytesRead: 1 + arg.consumed + arg.value };
    }
    // Text strings must be valid UTF-8: a decoder that hands back mojibake
    // would let a malformed `fmt` field compare unequal to every refusal
    // branch and fall through as "unknown format" instead of "malformed".
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(slice);
      return { ok: true, value: text, bytesRead: 1 + arg.consumed + arg.value };
    } catch {
      return { ok: false, reason: 'invalid-utf8' };
    }
  }
  if (major === 4 || major === 5) {
    if (payloadOffset + arg.value > bytes.length) {
      return { ok: false, reason: 'truncated' };
    }
    let cursor = payloadOffset;
    const remaining = arg.value;
    if (major === 4) {
      const items: CborValue[] = [];
      for (let i = 0; i < remaining; i++) {
        const item = decodeCborItem(bytes, cursor, depth + 1);
        if (item.ok === false) {
          return item;
        }
        items.push(item.value);
        cursor += item.bytesRead;
      }
      return { ok: true, value: items, bytesRead: cursor - offset };
    }
    const entries = new Map<CborValue, CborValue>();
    for (let i = 0; i < remaining; i++) {
      const key = decodeCborItem(bytes, cursor, depth + 1);
      if (key.ok === false) {
        return key;
      }
      cursor += key.bytesRead;
      const value = decodeCborItem(bytes, cursor, depth + 1);
      if (value.ok === false) {
        return value;
      }
      cursor += value.bytesRead;
      entries.set(key.value, value.value);
    }
    return { ok: true, value: entries, bytesRead: cursor - offset };
  }
  return { ok: false, reason: 'unsupported-type' };
}

/**
 * Decodes exactly one CBOR item from `bytes`, refusing trailing bytes.
 *
 * @param bytes - The input (at most {@linkcode MAX_CBOR_BYTES} bytes)
 * @returns The decoded value, or why it was refused
 */
export function decodeCbor(bytes: Uint8Array): CborOutcome {
  const item = decodeCborItem(bytes, 0, 1);
  if (item.ok === false) {
    return item;
  }
  if (item.bytesRead !== bytes.length) {
    return { ok: false, reason: 'trailing-bytes' };
  }
  return item;
}
