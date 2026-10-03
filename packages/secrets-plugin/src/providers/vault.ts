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
   * @throws {Error} On a non-404 HTTP error
   */
  async get(name: string): Promise<string | null> {
    const res = await this.#request(this.#dataUrl(name), {
      method: 'GET',
      headers: { 'X-Vault-Token': this.#token },
    });
    if (res.status === HTTP_NOT_FOUND) {
      return null;
    }
    if (!res.ok) {
      throw new Error(`Vault read failed for ${name}: HTTP ${res.status}`);
    }
    const body = await res.json() as VaultReadBody;
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
    });
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
      const res = await this.#request(`${this.#address}/v1/sys/health`, { method: 'GET' });
      // Release the unread body so the connection is not held open.
      await res.body?.cancel().catch(() => {
        // A body the transport already closed cannot be cancelled; the
        // status answer still proved reachability.
      });
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
   * answer, and the caller needs a retryable `503`, not a masked `500`. A
   * response — any status — is returned unchanged.
   */
  async #request(url: string, init: RequestInit): Promise<Response> {
    try {
      return await withDeadline((signal) => this.#http(url, { ...init, signal }), {
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
