/**
 * A software authenticator for the WebAuthn ceremonies (plan §5).
 *
 * Generates REAL Web Crypto key pairs (ES256, RS256, EdDSA), builds the CBOR
 * attestation object and the `authenticatorData` byte string the way a real
 * authenticator does, and signs assertions over
 * `authenticatorData ‖ SHA-256(clientDataJSON)` with real keys — so a test
 * that passes against it has exercised the plugin's real verification path,
 * not a scripted double. ES256 signatures are produced in the ASN.1 DER form
 * real authenticators emit.
 *
 * The counter, the flags, the origin and the challenge are controllable, so
 * the refusal cases (a lowered counter, UV unset, a foreign origin) are built
 * by the same code that builds the valid cases.
 *
 * @module
 */

/** WebAuthn flag bits. */
const FLAG_UP = 0x01;
const FLAG_AT = 0x40;
const FLAG_UV = 0x04;
const FLAG_BE = 0x08;

/** COSE key-type and curve labels. */
export const KTY_EC2 = 2;
export const KTY_RSA = 3;
export const KTY_OKP = 1;
export const CRV_P256 = 1;
export const CRV_ED25519 = 6;

/** COSE algorithm identifiers. */
export const ALG_ES256 = -7;
export const ALG_RS256 = -257;
export const ALG_EDDSA = -8;

/** The algorithms the virtual authenticator can hold. */
export type AuthenticatorAlgorithm = 'ES256' | 'RS256' | 'EdDSA';

/** The JSON shape a browser's `PublicKeyCredential.toJSON()` produces. */
export interface AuthenticatorResponseJson {
  readonly id: string;
  readonly rawId: string;
  readonly type: 'public-key';
  readonly response: Record<string, unknown>;
}

/** Encodes a CBOR unsigned integer (definite, minimal encoding). */
export function encodeUint(value: number): Uint8Array {
  if (value < 24) {
    return new Uint8Array([value]);
  }
  if (value < 256) {
    return new Uint8Array([24, value]);
  }
  if (value < 65536) {
    return new Uint8Array([25, value >> 8, value & 0xff]);
  }
  return new Uint8Array([
    26,
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

/** Encodes a CBOR negative integer: -1 - n. */
export function encodeNegative(value: number): Uint8Array {
  const encoded = encodeUint(-1 - value);
  encoded[0] = encoded[0]! | 0x20;
  return encoded;
}

/** Concatenates byte strings. */
function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Encodes a CBOR byte string. */
export function encodeByteString(bytes: Uint8Array): Uint8Array {
  const length = bytes.length;
  let header: Uint8Array;
  if (length < 24) {
    header = new Uint8Array([0x40 | length]);
  } else if (length < 256) {
    header = new Uint8Array([0x40 | 24, length]);
  } else {
    header = new Uint8Array([0x40 | 25, length >> 8, length & 0xff]);
  }
  return concat(header, bytes);
}

/** Encodes a CBOR text string. */
export function encodeTextString(text: string): Uint8Array {
  const bytes = new TextEncoder().encode(text);
  let header: Uint8Array;
  if (bytes.length < 24) {
    header = new Uint8Array([0x60 | bytes.length]);
  } else if (bytes.length < 256) {
    header = new Uint8Array([0x60 | 24, bytes.length]);
  } else {
    header = new Uint8Array([0x60 | 25, bytes.length >> 8, bytes.length & 0xff]);
  }
  return concat(header, bytes);
}

/** Encodes a CBOR map from string-keyed entries (definite length). */
export function encodeMap(entries: ReadonlyArray<readonly [Uint8Array, Uint8Array]>): Uint8Array {
  const count = entries.length;
  let header: Uint8Array;
  if (count < 24) {
    header = new Uint8Array([0xa0 | count]);
  } else if (count < 256) {
    header = new Uint8Array([0xa0 | 24, count]);
  } else {
    header = new Uint8Array([0xa0 | 25, count >> 8, count & 0xff]);
  }
  return concat(header, ...entries.flatMap(([key, value]) => [key, value]));
}

/** SHA-256 over `data`, as bytes. */
export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', data as BufferSource));
}

/** Base64url-encodes bytes without padding. */
export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Decodes a base64url string to bytes. */
export function fromBase64Url(input: string): Uint8Array {
  let base64 = input.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4 !== 0) {
    base64 += '=';
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** Encodes one DER INTEGER, adding the sign-bit 0x00 when required. */
function derInteger(value: Uint8Array): Uint8Array {
  let body = value;
  if (body.length === 0 || body[0]! >= 0x80) {
    body = concat(new Uint8Array([0x00]), body);
  }
  return concat(new Uint8Array([0x02, body.length]), body);
}

/** Converts a raw `r‖s` ECDSA signature to the DER form real authenticators emit. */
export function rawToDer(raw: Uint8Array): Uint8Array {
  const r = raw.slice(0, 32);
  const s = raw.slice(32, 64);
  const body = concat(derInteger(r), derInteger(s));
  return concat(new Uint8Array([0x30, body.length]), body);
}

/** Builds the COSE key bytes for the authenticator's public key. */
export function coseKeyBytes(
  algorithm: AuthenticatorAlgorithm,
  jwk: JsonWebKey,
): Uint8Array {
  const decode = (value: string): Uint8Array => fromBase64Url(value);
  if (algorithm === 'ES256') {
    return encodeMap([
      [encodeUint(1), encodeUint(KTY_EC2)],
      [encodeUint(3), encodeNegative(ALG_ES256)],
      [encodeNegative(-1), encodeUint(CRV_P256)],
      [encodeNegative(-2), encodeByteString(decode(jwk.x!))],
      [encodeNegative(-3), encodeByteString(decode(jwk.y!))],
    ]);
  }
  if (algorithm === 'RS256') {
    return encodeMap([
      [encodeUint(1), encodeUint(KTY_RSA)],
      [encodeUint(3), encodeNegative(ALG_RS256)],
      [encodeNegative(-1), encodeByteString(decode(jwk.n!))],
      [encodeNegative(-2), encodeByteString(decode(jwk.e!))],
    ]);
  }
  return encodeMap([
    [encodeUint(1), encodeUint(KTY_OKP)],
    [encodeUint(3), encodeNegative(ALG_EDDSA)],
    [encodeNegative(-1), encodeUint(CRV_ED25519)],
    [encodeNegative(-2), encodeByteString(decode(jwk.x!))],
  ]);
}

/** Options for {@linkcode buildAuthData}. */
export interface AuthDataOptions {
  /** The RP ID whose SHA-256 hash the byte string carries. */
  readonly rpId: string;
  /** The signature counter. */
  readonly counter?: number;
  /** Flag bits to set on top of nothing; UP/UV/BE/AT as WebAuthn defines. */
  readonly up?: boolean;
  readonly uv?: boolean;
  readonly backedUp?: boolean;
  /** The credential id, when attested credential data is included. */
  readonly credentialId?: Uint8Array;
  /** The COSE key bytes, when attested credential data is included. */
  readonly coseKey?: Uint8Array;
  /** Overrides the RP ID hash outright (a tamper case). */
  readonly rpIdHash?: Uint8Array;
}

/** Builds an `authenticatorData` byte string the way a real authenticator does. */
export async function buildAuthData(options: AuthDataOptions): Promise<Uint8Array> {
  const rpIdHash = options.rpIdHash ?? (await sha256(new TextEncoder().encode(options.rpId)));
  let flags = 0;
  if (options.up !== false) {
    flags |= FLAG_UP;
  }
  if (options.uv === true) {
    flags |= FLAG_UV;
  }
  if (options.backedUp === true) {
    flags |= FLAG_BE;
  }
  const counter = options.counter ?? 0;
  const counterBytes = new Uint8Array([
    (counter >>> 24) & 0xff,
    (counter >>> 16) & 0xff,
    (counter >>> 8) & 0xff,
    counter & 0xff,
  ]);
  if (options.credentialId !== undefined && options.coseKey !== undefined) {
    flags |= FLAG_AT;
  }
  const fixed = concat(rpIdHash, new Uint8Array([flags]), counterBytes);
  if (options.credentialId === undefined || options.coseKey === undefined) {
    return fixed;
  }
  const idLength = new Uint8Array([
    (options.credentialId.length >> 8) & 0xff,
    options.credentialId.length & 0xff,
  ]);
  return concat(
    fixed,
    new Uint8Array(16), // AAGUID: all zeros
    idLength,
    options.credentialId,
    options.coseKey,
  );
}

/** Options for {@linkcode buildClientData}. */
export interface ClientDataOptions {
  readonly type: string;
  readonly challenge: string;
  readonly origin: string;
  /** Sets `crossOrigin: true` (a tamper case). */
  readonly crossOrigin?: boolean;
}

/** Builds a base64url `clientDataJSON` the way a browser emits it. */
export function buildClientData(options: ClientDataOptions): string {
  const json: Record<string, unknown> = {
    type: options.type,
    challenge: options.challenge,
    origin: options.origin ?? 'http://localhost',
  };
  if (options.crossOrigin === true) {
    json.crossOrigin = true;
  }
  return toBase64Url(new TextEncoder().encode(JSON.stringify(json)));
}

/** Builds an attestation object (CBOR map) with the given `fmt` and `authData`. */
export function buildAttestationObject(
  fmt: string,
  authData: Uint8Array,
  attStmt: Uint8Array = encodeMap([]),
): Uint8Array {
  return encodeMap([
    [encodeTextString('fmt'), encodeTextString(fmt)],
    [encodeTextString('attStmt'), attStmt],
    [encodeTextString('authData'), encodeByteString(authData)],
  ]);
}

/**
 * A software authenticator holding one credential.
 *
 * The key pair is real Web Crypto, so every signature the fixture produces
 * verifies with the plugin's real verifier when every check passes.
 */
export class VirtualAuthenticator {
  readonly credentialId: Uint8Array;
  /**
   * The user handle the assertion carries. A real authenticator learns it
   * during registration; the tests set it to the handle the server issued so
   * a ceremony-issued handle (which is opaque to the authenticator) matches.
   */
  userHandle: Uint8Array;
  /** The signature counter; the tests control it for the cloned-authenticator case. */
  counter = 0;
  readonly #algorithm: AuthenticatorAlgorithm;
  readonly #keyPair: CryptoKeyPair;

  constructor(
    algorithm: AuthenticatorAlgorithm,
    keyPair: CryptoKeyPair,
    credentialId: Uint8Array,
    userHandle: Uint8Array,
  ) {
    this.#algorithm = algorithm;
    this.#keyPair = keyPair;
    this.credentialId = credentialId;
    this.userHandle = userHandle;
  }

  /**
   * Creates an authenticator with a fresh key pair of `algorithm`.
   *
   * @param algorithm - The credential algorithm to hold
   * @returns The authenticator
   */
  static async create(algorithm: AuthenticatorAlgorithm): Promise<VirtualAuthenticator> {
    const id = new Uint8Array(32);
    const handle = new Uint8Array(32);
    globalThis.crypto.getRandomValues(id);
    globalThis.crypto.getRandomValues(handle);
    const keyPair = await generateKeyPair(algorithm);
    return new VirtualAuthenticator(algorithm, keyPair, id, handle);
  }

  /** The credential's public key, in JWK form. */
  publicKeyJwk(): Promise<JsonWebKey> {
    return globalThis.crypto.subtle.exportKey('jwk', this.#keyPair.publicKey);
  }

  /** The COSE key bytes the registration attestation object carries. */
  async coseKey(): Promise<Uint8Array> {
    return coseKeyBytes(this.#algorithm, await this.publicKeyJwk());
  }

  /** Signs `data` with the credential's private key, in the form real authenticators emit. */
  async sign(data: Uint8Array): Promise<Uint8Array> {
    const signature = await globalThis.crypto.subtle.sign(
      this.#algorithm === 'ES256'
        ? { name: 'ECDSA', hash: 'SHA-256' }
        : this.#algorithm === 'RS256'
        ? { name: 'RSASSA-PKCS1-v1_5' }
        : { name: 'Ed25519' },
      this.#keyPair.privateKey,
      data as BufferSource,
    );
    const bytes = new Uint8Array(signature);
    return this.#algorithm === 'ES256' ? rawToDer(bytes) : bytes;
  }

  /**
   * Builds a registration response the way a browser's
   * `PublicKeyCredential.toJSON()` serializes it.
   *
   * @param options - The ceremony inputs and the tamper knobs the tests use
   * @returns The JSON body a registration verify request carries
   */
  async registrationResult(options: {
    readonly challenge: string;
    readonly rpId?: string;
    readonly origin?: string;
    readonly type?: string;
    readonly fmt?: string;
    readonly uv?: boolean;
    readonly up?: boolean;
    readonly backedUp?: boolean;
    readonly crossOrigin?: boolean;
    readonly counter?: number;
    /** Omits attested credential data entirely (a tamper case). */
    readonly omitCredentialData?: boolean;
    /** Replaces the COSE key bytes outright (an unsupported-algorithm case). */
    readonly coseKeyOverride?: Uint8Array;
    readonly transports?: readonly string[];
  }): Promise<AuthenticatorResponseJson> {
    const type = options.type ?? 'webauthn.create';
    const coseKey = options.coseKeyOverride ?? (await this.coseKey());
    const authData = await buildAuthData({
      rpId: options.rpId ?? 'localhost',
      counter: options.counter ?? 0,
      uv: options.uv ?? true,
      ...(options.up === undefined ? {} : { up: options.up }),
      ...(options.backedUp === undefined ? {} : { backedUp: options.backedUp }),
      ...(options.omitCredentialData === true ? {} : { credentialId: this.credentialId, coseKey }),
    });
    const attestationObject = buildAttestationObject(options.fmt ?? 'none', authData);
    const response: Record<string, unknown> = {
      clientDataJSON: buildClientData({
        type,
        challenge: options.challenge,
        origin: options.origin ?? 'http://localhost',
        ...(options.crossOrigin === undefined ? {} : { crossOrigin: options.crossOrigin }),
      }),
      attestationObject: toBase64Url(attestationObject),
      transports: [...(options.transports ?? ['internal'])],
    };
    return {
      id: toBase64Url(this.credentialId),
      rawId: toBase64Url(this.credentialId),
      type: 'public-key',
      response,
    };
  }

  /**
   * Builds an authentication response the way a browser's
   * `PublicKeyCredential.toJSON()` serializes it, signing over
   * `authenticatorData ‖ SHA-256(clientDataJSON)`.
   *
   * @param options - The ceremony inputs and the tamper knobs the tests use
   * @returns The JSON body an authentication verify request carries
   */
  async assertionResult(options: {
    readonly challenge: string;
    readonly rpId?: string;
    readonly origin?: string;
    readonly type?: string;
    readonly uv?: boolean;
    readonly up?: boolean;
    readonly crossOrigin?: boolean;
    /** The counter the assertion carries; advances the authenticator's own by default. */
    readonly counter?: number;
    /** Omits the `userHandle` field (a non-discoverable response). */
    readonly omitUserHandle?: boolean;
    /** Replaces the user handle outright (a mismatch case). */
    readonly userHandle?: Uint8Array;
    /** Signs over different data than the response carries (a tamper case). */
    readonly signOver?: Uint8Array;
    /** Replaces the signature outright (a forgery case). */
    readonly signatureOverride?: Uint8Array;
  }): Promise<AuthenticatorResponseJson> {
    const type = options.type ?? 'webauthn.get';
    const clientDataJson = buildClientData({
      type,
      challenge: options.challenge,
      origin: options.origin ?? 'http://localhost',
      ...(options.crossOrigin === undefined ? {} : { crossOrigin: options.crossOrigin }),
    });
    const clientDataBytes = fromBase64Url(clientDataJson);
    const counter = options.counter ?? ++this.counter;
    const authData = await buildAuthData({
      rpId: options.rpId ?? 'localhost',
      counter,
      uv: options.uv ?? true,
      ...(options.up === undefined ? {} : { up: options.up }),
    });
    const signed = options.signOver ??
      concat(authData, await sha256(clientDataBytes));
    const signature = options.signatureOverride ?? (await this.sign(signed));
    const response: Record<string, unknown> = {
      clientDataJSON: clientDataJson,
      authenticatorData: toBase64Url(authData),
      signature: toBase64Url(signature),
      ...(options.omitUserHandle === true
        ? {}
        : { userHandle: toBase64Url(options.userHandle ?? this.userHandle) }),
    };
    return {
      id: toBase64Url(this.credentialId),
      rawId: toBase64Url(this.credentialId),
      type: 'public-key',
      response,
    };
  }
}

/** Generates a real Web Crypto key pair for `algorithm`. */
async function generateKeyPair(algorithm: AuthenticatorAlgorithm): Promise<CryptoKeyPair> {
  // The Ed25519 overload widens to `CryptoKeyPair | CryptoKey` in the DOM
  // types, though it always returns a pair for these algorithms; the cast
  // records that, and `#keyPair`'s uses would fail loudly otherwise.
  if (algorithm === 'ES256') {
    const pair = await globalThis.crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify'],
    );
    return pair as CryptoKeyPair;
  }
  if (algorithm === 'RS256') {
    const pair = await globalThis.crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['sign', 'verify'],
    );
    return pair as CryptoKeyPair;
  }
  const pair = await globalThis.crypto.subtle.generateKey(
    { name: 'Ed25519' },
    true,
    ['sign', 'verify'],
  );
  return pair as unknown as CryptoKeyPair;
}
