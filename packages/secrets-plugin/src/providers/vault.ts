/**
 * HashiCorpVaultProvider — retrieves and rotates secrets in HashiCorp Vault's
 * KV v2 engine over the web-standard `fetch` (no SDK, Workers-compatible). A
 * secret's string value is stored under the `value` field of the KV item.
 *
 * @module
 */
import { deadlineRangeError, withDeadline } from '@setu-ts/common';
import type { DeadlineOptions } from '@setu-ts/common';
import type { IVaultHttp, SecretProvider } from '../interfaces/index.ts';
import { SecretProviderUnavailableError } from '../errors.ts';

/** Provider name carried on {@linkcode SecretProviderUnavailableError}. */
const PROVIDER_NAME = 'HashiCorpVaultProvider';

/** Default bound on one Vault request, in milliseconds. */
const DEFAULT_REQUEST_TIMEOUT_MS = 5000;

/** HTTP status signalling an absent secret. */
const HTTP_NOT_FOUND = 404;

/** Default KV v2 mount path. */
const DEFAULT_MOUNT = 'secret';

/** KV field under which the secret string is stored. */
const VALUE_FIELD = 'value';

/**
 * Options for {@linkcode HashiCorpVaultProvider}.
 *
 * @since 0.1.0
 */
export interface HashiCorpVaultProviderOptions {
  /** Vault server address, e.g. `https://vault.example.com`. */
  address?: string | undefined;
  /** Vault auth token sent as `X-Vault-Token`. */
  token?: string | undefined;
  /** KV v2 mount path. Default `secret`. */
  mount?: string | undefined;
  /** Injected `fetch`-shaped function; defaults to global `fetch`. */
  http?: IVaultHttp | undefined;
  /**
   * Bound on one Vault request, in milliseconds (M101a V8-4). A request that
   * fails on the network or does not answer in time rejects with
   * {@linkcode SecretProviderUnavailableError} (`503`) and its signal is
   * aborted. `0` disables the bound. Must be a finite number in
   * `0`–`2147483647`; anything else throws `RangeError` at construction.
   *
   * @default 5000
   * @since 0.9.0
   */
  requestTimeoutMs?: number | undefined;
  /**
   * Timer surface the bound runs on. `SecretsPlugin` supplies the runtime's
   * timers; a directly constructed provider falls back to the ambient
   * `setTimeout`/`clearTimeout`.
   *
   * @since 0.9.0
   */
  timing?: DeadlineOptions['timing'];
}

/** Shape of a Vault KV v2 read response body. */
interface VaultReadBody {
  data?: { data?: Record<string, unknown> };
}

/**
 * What one bounded request yields: the status, and the body text when it was
 * asked for. The body is read (or released) INSIDE the bound, so a server that
 * sends headers and then stalls cannot outlive `requestTimeoutMs`.
 */
interface VaultAnswer {
  readonly status: number;
  readonly ok: boolean;
  readonly text: string | null;
}

/** URL schemes a Vault address may use. */
const ADDRESS_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:']);

/**
 * Whether `address` parses as an absolute `http:`/`https:` URL.
 *
 * @param address - The configured address, trailing slashes trimmed
 */
function isValidAddress(address: string): boolean {
  try {
    return ADDRESS_PROTOCOLS.has(new URL(address).protocol);
  } catch {
    return false;
  }
}

/**
 * HashiCorp Vault (KV v2) provider.
 *
 * @since 0.1.0
 */
export class HashiCorpVaultProvider implements SecretProvider {
  readonly #address: string;
  readonly #token: string;
  readonly #mount: string;
  readonly #http: IVaultHttp;
  readonly #timeoutMs: number;
  readonly #timing: DeadlineOptions['timing'];
  #ready = false;

  /**
   * @param options - Vault connection/injection options
   * @throws {RangeError} When `requestTimeoutMs` is out of range
   */
  constructor(options?: HashiCorpVaultProviderOptions) {
    this.#address = (options?.address ?? '').replace(/\/+$/, '');
    this.#token = options?.token ?? '';
    this.#mount = options?.mount ?? DEFAULT_MOUNT;
    this.#http = options?.http ?? ((url, init): Promise<Response> => fetch(url, init));
    this.#timeoutMs = options?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const refusal = deadlineRangeError('requestTimeoutMs', this.#timeoutMs);
    if (refusal !== null) {
      throw refusal;
    }
    this.#timing = options?.timing;
  }

  connect(): Promise<void> {
    if (this.#address === '') {
      return Promise.reject(new Error('HashiCorpVaultProvider requires options.address'));
    }
    if (!isValidAddress(this.#address)) {
      // The value is not echoed: an address can carry credentials in its
      // userinfo, and the message reaches logs.
      return Promise.reject(
        new Error('HashiCorpVaultProvider requires options.address to be an http(s) URL'),
      );
    }
    if (this.#token === '') {
      return Promise.reject(new Error('HashiCorpVaultProvider requires options.token'));
    }
    this.#ready = true;
    return Promise.resolve();
  }

  disconnect(): Promise<void> {
    this.#ready = false;
    return Promise.resolve();
  }

  isReady(): boolean {
    return this.#ready;
  }

  /**
   * Reads a secret from Vault's KV v2 engine.
   *
   * @param name - The secret path (relative to the mount)
   * @returns The value, or `null` when absent
   * @throws {SecretProviderUnavailableError} When Vault cannot be reached or
   *   does not answer within `requestTimeoutMs`
   * @throws {Error} On a non-404 HTTP error or a body that is not JSON
   */
  async get(name: string): Promise<string | null> {
    const res = await this.#request(this.#dataUrl(name), {
      method: 'GET',
      headers: { 'X-Vault-Token': this.#token },
    }, true);
    if (res.status === HTTP_NOT_FOUND) {
      return null;
    }
    if (!res.ok) {
      throw new Error(`Vault read failed for ${name}: HTTP ${res.status}`);
    }
    // Parsed outside the bound: a Vault that answered with a malformed body
    // is a plain error, not an unreachable provider.
    const body = JSON.parse(res.text ?? '') as VaultReadBody;
    const value = body.data?.data?.[VALUE_FIELD];
    return typeof value === 'string' ? value : null;
  }

  /**
   * Writes a new secret version to Vault's KV v2 engine.
   *
   * @param name - The secret path (relative to the mount)
   * @param value - The new value
   * @throws {SecretProviderUnavailableError} When Vault cannot be reached or
   *   does not answer within `requestTimeoutMs`
   * @throws {Error} On any HTTP error
   */
  async set(name: string, value: string): Promise<void> {
    const res = await this.#request(this.#dataUrl(name), {
      method: 'POST',
      headers: {
        'X-Vault-Token': this.#token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ data: { [VALUE_FIELD]: value } }),
    }, false);
    if (!res.ok) {
      throw new Error(`Vault write failed for ${name}: HTTP ${res.status}`);
    }
  }

  /**
   * Probes Vault's unauthenticated `/v1/sys/health` (M90b). Any HTTP
   * response proves the server answered — Vault reports its standby and
   * sealing states through STATUS CODES on this endpoint, all of which mean
   * "reachable" — and a network failure does not. No secret is read and the
   * auth token is not sent: the health endpoint is unauthenticated by
   * design, and a read is not a probe.
   *
   * @returns `true` when the Vault server answers
   * @since 0.5.0
   */
  async isHealthy(): Promise<boolean> {
    if (this.#address === '') {
      return false;
    }
    try {
      await this.#request(`${this.#address}/v1/sys/health`, { method: 'GET' }, false);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Sends one request under the `requestTimeoutMs` bound (M101a V8-4).
   *
   * A transport failure and an expired bound both become
   * {@linkcode SecretProviderUnavailableError}: either way Vault did not
   * answer, and the caller needs a retryable `503`, not a masked `500`. Any
   * status is returned unchanged. The body is consumed inside the same bound:
   * read as text when `readBody` is set and the status carries one worth
   * reading, otherwise cancelled so the connection is not held open — so a
   * server that sends headers and then stalls is unreachable too.
   */
  async #request(url: string, init: RequestInit, readBody: boolean): Promise<VaultAnswer> {
    try {
      return await withDeadline(async (signal) => {
        const res = await this.#http(url, { ...init, signal });
        if (readBody && res.ok) {
          return { status: res.status, ok: true, text: await res.text() };
        }
        await res.body?.cancel().catch(() => {
          // A body the transport already closed cannot be cancelled; the
          // status still answered.
        });
        return { status: res.status, ok: res.ok, text: null };
      }, {
        timeoutMs: this.#timeoutMs,
        onTimeout: () => new Error(`Vault did not answer within ${this.#timeoutMs} ms`),
        ...(this.#timing !== undefined && { timing: this.#timing }),
      });
    } catch (error) {
      throw new SecretProviderUnavailableError(PROVIDER_NAME, error);
    }
  }

  /** Builds the KV v2 data URL for a secret path. */
  #dataUrl(name: string): string {
    return `${this.#address}/v1/${this.#mount}/data/${name}`;
  }
}
