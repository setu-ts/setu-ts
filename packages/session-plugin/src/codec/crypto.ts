/**
 * Session cookie protection over `runtime.subtle` (Web Crypto).
 *
 * Keys are derived from the configured secret(s) with HKDF-SHA256, following
 * the M16 `JwtService` precedent of going through `IRuntimeServices.subtle`
 * rather than any runtime-specific crypto module. That keeps the whole scheme
 * dependency-free and portable to Cloudflare Workers.
 *
 * Every key is derived once, during `register()`, so an unsupported runtime
 * fails at startup with a named error instead of on the first request.
 *
 * @module
 */
import {
  decodeEnvelope,
  encodeEnvelope,
  fromUtf8,
  IV_LENGTH,
  toBase64Url,
  toBuffer,
  utf8,
} from './envelope.ts';
import { timingSafeEqualBytes } from './timing-safe.ts';

/** How a session cookie is protected. */
export type SessionMode = 'encrypt' | 'sign';

/** HKDF `info` label for the AES-GCM encryption key. */
const INFO_ENCRYPT = 'setu-ts-session-encrypt-v1';
/** HKDF `info` label for the HMAC signing key. */
const INFO_SIGN = 'setu-ts-session-sign-v1';
/** HKDF `info` label for the non-secret key-id fingerprint. */
const INFO_KID = 'setu-ts-session-kid-v1';
/** Characters of the fingerprint kept as the key id. */
const KID_LENGTH = 8;

/**
 * One derived key, addressable by its non-secret id.
 *
 * @since 0.2.0
 */
export interface SessionKey {
  /**
   * Short non-secret fingerprint of the source secret, carried in the envelope
   * so that opening is a direct lookup rather than a trial over every key.
   */
  readonly kid: string;
  /** The mode-appropriate `CryptoKey` derived from the secret. */
  readonly key: CryptoKey;
}

/**
 * An ordered key ring. Index 0 is current and seals everything; every entry can
 * open, which is what lets a secret rotate without invalidating live sessions.
 *
 * @since 0.2.0
 */
export interface KeyRing {
  /** Keys in configuration order — index 0 is current. */
  readonly keys: readonly SessionKey[];
  /** Lookup from key id to key. */
  readonly byKid: ReadonlyMap<string, SessionKey>;
  /** The mode these keys were derived for. */
  readonly mode: SessionMode;
}

/**
 * Derives a key ring from one or more secrets.
 *
 * @param subtle - Web Crypto interface, from `IRuntimeServices.subtle`
 * @param secrets - Secrets in priority order; index 0 becomes the current key
 * @param mode - Which key type to derive
 * @returns The derived key ring
 * @throws {Error} If the runtime's Web Crypto cannot perform HKDF
 * @since 0.2.0
 */
export async function deriveKeyRing(
  subtle: SubtleCrypto,
  secrets: readonly string[],
  mode: SessionMode,
): Promise<KeyRing> {
  const keys: SessionKey[] = [];
  const byKid = new Map<string, SessionKey>();

  for (const secret of secrets) {
    const kid = await deriveKid(subtle, secret);
    const key = mode === 'encrypt'
      ? await deriveAesKey(subtle, secret)
      : await deriveHmacKey(subtle, secret);
    const entry: SessionKey = { kid, key };
    keys.push(entry);
    // A repeated secret yields a repeated kid; first occurrence wins so the
    // current key stays addressable.
    if (!byKid.has(kid)) {
      byKid.set(kid, entry);
    }
  }

  return { keys, byKid, mode };
}

/**
 * Seals a payload into a cookie value using the ring's current key.
 *
 * @param subtle - Web Crypto interface
 * @param ring - The key ring; index 0 seals
 * @param payload - The plaintext payload (serialized session JSON)
 * @param randomBytes - Random byte source, from `IRuntimeServices.randomBytes`
 * @returns The envelope string to put in the cookie
 * @throws {Error} If the key ring is empty
 * @since 0.2.0
 */
export async function seal(
  subtle: SubtleCrypto,
  ring: KeyRing,
  payload: string,
  randomBytes: (size: number) => Uint8Array,
): Promise<string> {
  const current = ring.keys[0];
  if (current === undefined) {
    throw new Error('Cannot seal a session: the key ring is empty.');
  }

  if (ring.mode === 'encrypt') {
    const iv = randomBytes(IV_LENGTH);
    const sealed = new Uint8Array(
      await subtle.encrypt(
        { name: 'AES-GCM', iv: toBuffer(iv), tagLength: 128 },
        current.key,
        toBuffer(utf8(payload)),
      ),
    );
    return encodeEnvelope(current.kid, iv, sealed);
  }

  // 'sign' — the payload stays readable; only its integrity is protected.
  const payloadBytes = utf8(payload);
  const encoded = utf8(toBase64Url(payloadBytes));
  const mac = new Uint8Array(await subtle.sign('HMAC', current.key, toBuffer(encoded)));
  return encodeEnvelope(current.kid, payloadBytes, mac);
}

/**
 * Opens a cookie value, returning `null` whenever it cannot be trusted.
 *
 * Returns `null` for a malformed envelope, an unknown key id, a failed
 * authentication tag or HMAC, and a payload that is not valid UTF-8 — every
 * one of which means "no session" rather than an error to propagate. That is
 * the property that makes a tampered cookie yield an empty session instead of
 * attacker-controlled data.
 *
 * @param subtle - Web Crypto interface
 * @param ring - The key ring; any entry may open
 * @param raw - The raw cookie value
 * @returns The plaintext payload, or `null` when it cannot be opened
 * @since 0.2.0
 */
export async function open(
  subtle: SubtleCrypto,
  ring: KeyRing,
  raw: string,
): Promise<string | null> {
  const envelope = decodeEnvelope(raw, ring.mode === 'encrypt' ? IV_LENGTH : undefined);
  if (envelope === null) {
    return null;
  }

  const entry = ring.byKid.get(envelope.kid);
  if (entry === undefined) {
    return null;
  }

  if (ring.mode === 'encrypt') {
    try {
      const plaintext = await subtle.decrypt(
        { name: 'AES-GCM', iv: toBuffer(envelope.first), tagLength: 128 },
        entry.key,
        toBuffer(envelope.second),
      );
      return fromUtf8(new Uint8Array(plaintext));
    } catch {
      // Authentication-tag mismatch, wrong key, or corrupt ciphertext.
      return null;
    }
  }

  const encoded = utf8(toBase64Url(envelope.first));
  const expected = new Uint8Array(await subtle.sign('HMAC', entry.key, toBuffer(encoded)));
  // Compared in constant time rather than via subtle.verify so the comparison
  // path is identical to the CSRF token's, and provably non-short-circuiting.
  if (!timingSafeEqualBytes(expected, envelope.second)) {
    return null;
  }
  return fromUtf8(envelope.first);
}

/** Imports a secret as HKDF input key material. */
async function importIkm(subtle: SubtleCrypto, secret: string): Promise<CryptoKey> {
  return await subtle.importKey('raw', toBuffer(utf8(secret)), 'HKDF', false, [
    'deriveKey',
    'deriveBits',
  ]);
}

/** HKDF parameters for a given `info` label. Salt is empty by design: the */
/** secret is already high-entropy, and an empty salt keeps derivation */
/** deterministic across processes, which a session cookie requires. */
function hkdfParams(info: string): HkdfParams {
  return { name: 'HKDF', hash: 'SHA-256', salt: new ArrayBuffer(0), info: toBuffer(utf8(info)) };
}

/** Derives the AES-256-GCM key for `'encrypt'` mode. */
async function deriveAesKey(subtle: SubtleCrypto, secret: string): Promise<CryptoKey> {
  return await subtle.deriveKey(
    hkdfParams(INFO_ENCRYPT),
    await importIkm(subtle, secret),
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Derives the HMAC-SHA256 key for `'sign'` mode. */
async function deriveHmacKey(subtle: SubtleCrypto, secret: string): Promise<CryptoKey> {
  return await subtle.deriveKey(
    hkdfParams(INFO_SIGN),
    await importIkm(subtle, secret),
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign', 'verify'],
  );
}

/**
 * Derives the non-secret key id: a truncated HKDF output under a distinct
 * `info` label, so it cannot be used to recover either the secret or the
 * working key.
 */
async function deriveKid(subtle: SubtleCrypto, secret: string): Promise<string> {
  const bits = await subtle.deriveBits(
    hkdfParams(INFO_KID),
    await importIkm(subtle, secret),
    128,
  );
  return toBase64Url(new Uint8Array(bits)).slice(0, KID_LENGTH);
}
