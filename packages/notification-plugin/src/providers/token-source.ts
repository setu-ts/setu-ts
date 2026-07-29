/**
 * OAuth2 access tokens for FCM HTTP v1, minted from a service account.
 *
 * FCM v1 authenticates with a short-lived bearer token rather than a static
 * key. The token is obtained by signing a JWT assertion with the service
 * account's private key (RS256) and exchanging it at Google's token endpoint.
 * Signing uses `runtime.subtle`, so this carries no npm dependency and runs on
 * every runtime including Cloudflare Workers.
 *
 * @module
 */

import type { IRuntimeServices } from '@hono-enterprise/common';
import type { FcmTokenSource, INotificationHttp } from '../interfaces/index.ts';
import { pemToDer } from './pem.ts';

/** Google's OAuth2 token endpoint, and the JWT assertion's `aud`. */
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

/** OAuth2 scope required to send FCM messages. */
const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

/** Assertion grant type for a service-account JWT exchange. */
const JWT_BEARER_GRANT = 'urn:ietf:params:oauth:grant-type:jwt-bearer';

/** Lifetime requested for the JWT assertion. Google caps this at one hour. */
const ASSERTION_TTL_SECONDS = 3600;

/**
 * Refresh this long before a token's nominal expiry, so a token is never
 * presented to FCM in the window where clock skew or flight time could have
 * pushed it past the deadline.
 */
const REFRESH_MARGIN_MS = 60_000;

/** Construction inputs for {@linkcode ServiceAccountTokenSource}. */
export interface ServiceAccountTokenSourceOptions {
  /** Service-account email; becomes the assertion's `iss`. */
  readonly clientEmail: string;
  /** PEM PKCS#8 private key used to sign the assertion. */
  readonly privateKey: string;
  /** Runtime services supplying Web Crypto and the wall clock. */
  readonly runtime: IRuntimeServices;
  /** HTTP seam used for the token exchange. */
  readonly http: INotificationHttp;
}

/** Base64url-encodes bytes or a string, unpadded, per JWS. */
function base64url(input: string | Uint8Array): string {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Shape of a successful OAuth2 token response. */
interface TokenResponse {
  readonly access_token: string;
  readonly expires_in: number;
}

function isTokenResponse(value: unknown): value is TokenResponse {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as { access_token?: unknown; expires_in?: unknown };
  return typeof candidate.access_token === 'string' && typeof candidate.expires_in === 'number';
}

/**
 * Mints FCM access tokens by signing a service-account JWT assertion and
 * exchanging it for an OAuth2 token, caching the result until shortly before it
 * expires.
 *
 * The signing key is imported once and reused; tokens are valid for about an
 * hour, so re-signing per notification would add an RSA signature and a network
 * round trip to every send.
 *
 * @since 0.1.0
 */
export class ServiceAccountTokenSource implements FcmTokenSource {
  readonly #clientEmail: string;
  readonly #privateKey: string;
  readonly #runtime: IRuntimeServices;
  readonly #http: INotificationHttp;
  #signKey: CryptoKey | null = null;
  #cachedToken: string | null = null;
  #expiresAtMs = 0;

  /**
   * @param options - Service-account credentials and the runtime/HTTP seams
   */
  constructor(options: ServiceAccountTokenSourceOptions) {
    this.#clientEmail = options.clientEmail;
    this.#privateKey = options.privateKey;
    this.#runtime = options.runtime;
    this.#http = options.http;
  }

  /**
   * Returns a cached token when one is still comfortably valid, otherwise
   * signs a fresh assertion and exchanges it.
   *
   * @returns The bearer token to present to FCM
   * @throws {Error} If the private key cannot be imported, or the token
   * exchange returns a non-OK response or an unrecognized body
   * @since 0.1.0
   */
  async getAccessToken(): Promise<string> {
    if (this.#cachedToken !== null && this.#runtime.now() < this.#expiresAtMs) {
      return this.#cachedToken;
    }

    const assertion = await this.#createAssertion();
    const body = `grant_type=${encodeURIComponent(JWT_BEARER_GRANT)}&assertion=${
      encodeURIComponent(assertion)
    }`;

    const response = await this.#http.post(TOKEN_ENDPOINT, body, {
      'Content-Type': 'application/x-www-form-urlencoded',
    });
    if (!response.ok) {
      throw new Error(
        `FCM token exchange failed (${response.status}): ${response.text}`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(response.text);
    } catch {
      throw new Error('FCM token exchange returned a non-JSON body');
    }
    if (!isTokenResponse(parsed)) {
      throw new Error('FCM token exchange returned no access_token');
    }

    this.#cachedToken = parsed.access_token;
    this.#expiresAtMs = this.#runtime.now() + parsed.expires_in * 1000 - REFRESH_MARGIN_MS;
    return parsed.access_token;
  }

  /** Builds and signs the RS256 JWT assertion. */
  async #createAssertion(): Promise<string> {
    const key = await this.#getSignKey();
    const issuedAt = Math.floor(this.#runtime.now() / 1000);

    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = base64url(JSON.stringify({
      iss: this.#clientEmail,
      scope: FCM_SCOPE,
      aud: TOKEN_ENDPOINT,
      iat: issuedAt,
      exp: issuedAt + ASSERTION_TTL_SECONDS,
    }));
    const signingInput = `${header}.${claims}`;

    const signature = await this.#runtime.subtle.sign(
      { name: 'RSASSA-PKCS1-v1_5' },
      key,
      new TextEncoder().encode(signingInput),
    );

    return `${signingInput}.${base64url(new Uint8Array(signature))}`;
  }

  /** Imports the PKCS#8 signing key once and caches it. */
  async #getSignKey(): Promise<CryptoKey> {
    if (this.#signKey === null) {
      this.#signKey = await this.#runtime.subtle.importKey(
        'pkcs8',
        pemToDer(this.#privateKey, 'PRIVATE KEY') as unknown as BufferSource,
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['sign'],
      );
    }
    return this.#signKey;
  }
}
