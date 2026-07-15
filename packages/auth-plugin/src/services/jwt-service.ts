/**
 * JWT service implementation using Web Crypto.
 *
 * @module
 */

import type { IJwtService, JwtSignOptions } from '@hono-enterprise/common';
import type { IRuntimeServices } from '@hono-enterprise/common';
import { decodeBase64Url, encodeBase64Url } from '../utils/base64url.ts';
import { toBuffer } from '../utils/buffer.ts';
import { pemToDer } from '../utils/pem.ts';
import { parseDuration } from '../utils/duration.ts';

/**
 * Internal options for JWT service construction.
 */
interface JwtServiceOptions {
  readonly secret?: string | Uint8Array;
  readonly privateKey?: string;
  readonly publicKey?: string;
  readonly algorithm: 'HS256' | 'RS256';
  readonly expectedAudience?: string;
  readonly expectedIssuer?: string;
}

/**
 * JWT service implementing IJwtService using Web Crypto (HS256/RS256).
 */
export class JwtService implements IJwtService {
  private readonly runtime: IRuntimeServices;
  private readonly options: JwtServiceOptions;
  private cachedSignKey?: CryptoKey;
  private cachedVerifyKey?: CryptoKey;

  constructor(runtime: IRuntimeServices, options: JwtServiceOptions) {
    this.runtime = runtime;
    this.options = options;

    if (options.algorithm === 'HS256' && !options.secret) {
      throw new Error('HS256 requires a secret key');
    }
    if (options.algorithm === 'RS256' && (!options.privateKey || !options.publicKey)) {
      throw new Error('RS256 requires both private and public keys');
    }
  }

  /**
   * Get or cache the signing key (HS256: same for sign+verify; RS256: private key).
   */
  private async getSignKey(): Promise<CryptoKey> {
    if (this.cachedSignKey) {
      return this.cachedSignKey;
    }

    if (this.options.algorithm === 'HS256') {
      const secret = this.options.secret!;
      const keyBytes = typeof secret === 'string' ? new TextEncoder().encode(secret) : secret;

      this.cachedSignKey = await this.runtime.subtle.importKey(
        'raw',
        toBuffer(keyBytes),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign', 'verify'],
      );
      // For HS256, sign and verify use the same key
      this.cachedVerifyKey = this.cachedSignKey;
    } else {
      // RS256 - private key for signing
      const der = pemToDer(this.options.privateKey!, 'PRIVATE KEY');
      this.cachedSignKey = await this.runtime.subtle.importKey(
        'pkcs8',
        toBuffer(der),
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['sign'],
      );
    }

    return this.cachedSignKey;
  }

  /**
   * Get or cache the verification key (RS256: public key).
   */
  private async getVerifyKey(): Promise<CryptoKey> {
    if (this.cachedVerifyKey) {
      return this.cachedVerifyKey;
    }

    if (this.options.algorithm === 'HS256') {
      // Reuse the sign key (same key for HMAC)
      return this.getSignKey();
    }

    // RS256 - public key for verification
    const der = pemToDer(this.options.publicKey!, 'PUBLIC KEY');
    this.cachedVerifyKey = await this.runtime.subtle.importKey(
      'spki',
      toBuffer(der),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );

    return this.cachedVerifyKey;
  }

  async sign(
    payload: Readonly<Record<string, unknown>>,
    options?: JwtSignOptions,
  ): Promise<string> {
    const header = { alg: this.options.algorithm, typ: 'JWT' };

    const iat = Math.floor(this.runtime.now() / 1000);
    const claims: Record<string, unknown> = { ...payload, iat };

    if (options?.expiresIn) {
      const expiresInMs = parseDuration(options.expiresIn);
      claims.exp = iat + Math.floor(expiresInMs / 1000);
    }
    if (options?.audience) {
      claims.aud = options.audience;
    } else if (this.options.expectedAudience) {
      claims.aud = this.options.expectedAudience;
    }
    if (options?.issuer) {
      claims.iss = options.issuer;
    } else if (this.options.expectedIssuer) {
      claims.iss = this.options.expectedIssuer;
    }

    const headerB64 = encodeBase64Url(new TextEncoder().encode(JSON.stringify(header)));
    const payloadB64 = encodeBase64Url(new TextEncoder().encode(JSON.stringify(claims)));

    const message = `${headerB64}.${payloadB64}`;
    const messageBytes = toBuffer(new TextEncoder().encode(message));

    const key = await this.getSignKey();
    const signature = await this.runtime.subtle.sign(
      this.options.algorithm === 'HS256' ? { name: 'HMAC' } : { name: 'RSASSA-PKCS1-v1_5' },
      key,
      messageBytes,
    );
    const signatureB64 = encodeBase64Url(new Uint8Array(signature));

    return `${message}.${signatureB64}`;
  }

  async verify<T = Readonly<Record<string, unknown>>>(token: string): Promise<T> {
    const parts = token.split('.');
    if (parts.length !== 3) {
      throw new Error('Invalid token format: expected 3 parts');
    }

    const [headerB64, payloadB64, signatureB64] = parts;

    // Verify signature
    const message = `${headerB64}.${payloadB64}`;
    const messageBytes = toBuffer(new TextEncoder().encode(message));
    const signatureBytes = toBuffer(decodeBase64Url(signatureB64));

    const key = await this.getVerifyKey();
    const isValid = await this.runtime.subtle.verify(
      this.options.algorithm === 'HS256' ? { name: 'HMAC' } : { name: 'RSASSA-PKCS1-v1_5' },
      key,
      signatureBytes,
      messageBytes,
    );

    if (!isValid) {
      throw new Error('Invalid token signature');
    }

    // Parse payload
    let payload: unknown;
    try {
      const payloadBytes = decodeBase64Url(payloadB64);
      payload = JSON.parse(new TextDecoder().decode(payloadBytes));
    } catch {
      throw new Error('Invalid token payload');
    }

    // Validate time-based claims
    const now = Math.floor(this.runtime.now() / 1000);
    const payloadObj = payload as Record<string, unknown>;

    if (typeof payloadObj.exp === 'number' && payloadObj.exp < now) {
      throw new Error('Token expired');
    }
    if (typeof payloadObj.nbf === 'number' && payloadObj.nbf > now) {
      throw new Error('Token not yet valid');
    }

    // Validate audience
    if (this.options.expectedAudience) {
      if (payloadObj.aud !== this.options.expectedAudience) {
        throw new Error('Invalid token audience');
      }
    }

    // Validate issuer
    if (this.options.expectedIssuer) {
      if (payloadObj.iss !== this.options.expectedIssuer) {
        throw new Error('Invalid token issuer');
      }
    }

    return payload as T;
  }

  decode<T = Readonly<Record<string, unknown>>>(token: string): T | null {
    const parts = token.split('.');
    if (parts.length !== 3) {
      return null;
    }

    const [, payloadB64] = parts;
    try {
      const payloadBytes = decodeBase64Url(payloadB64);
      return JSON.parse(new TextDecoder().decode(payloadBytes)) as T;
    } catch {
      return null;
    }
  }
}
