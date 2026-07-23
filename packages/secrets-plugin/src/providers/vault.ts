/**
 * HashiCorpVaultProvider — retrieves and rotates secrets in HashiCorp Vault's
 * KV v2 engine over the web-standard `fetch` (no SDK, Workers-compatible). A
 * secret's string value is stored under the `value` field of the KV item.
 *
 * @module
 */
import type { IVaultHttp, SecretProvider } from '../interfaces/index.ts';

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
  #ready = false;

  /**
   * @param options - Vault connection/injection options
   */
  constructor(options?: HashiCorpVaultProviderOptions) {
    this.#address = (options?.address ?? '').replace(/\/+$/, '');
    this.#token = options?.token ?? '';
    this.#mount = options?.mount ?? DEFAULT_MOUNT;
    this.#http = options?.http ?? ((url, init): Promise<Response> => fetch(url, init));
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
   * @throws {Error} On a non-404 HTTP error
   */
  async get(name: string): Promise<string | null> {
    const res = await this.#http(this.#dataUrl(name), {
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
   * @throws {Error} On any HTTP error
   */
  async set(name: string, value: string): Promise<void> {
    const res = await this.#http(this.#dataUrl(name), {
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

  /** Builds the KV v2 data URL for a secret path. */
  #dataUrl(name: string): string {
    return `${this.#address}/v1/${this.#mount}/data/${name}`;
  }
}
