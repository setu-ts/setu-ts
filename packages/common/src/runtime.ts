/**
 * Runtime abstraction — the contract the RuntimePlugin fulfills so that no
 * other package ever touches runtime-specific APIs (AI_GUIDELINES §4).
 *
 * @module
 */
import type { RuntimePlatform } from './types.ts';
import type { IRequest, IResponse } from './http.ts';

/**
 * Opaque handle returned by runtime timer methods. Its concrete shape is
 * runtime-specific (a number on Deno, an object on Node); consumers only
 * ever pass it back to `clearTimeout`/`clearInterval`.
 *
 * @since 0.1.0
 */
export type TimerHandle = unknown;

/**
 * Opaque handle for a running HTTP server, created and consumed only by the
 * runtime's HTTP adapter.
 *
 * @since 0.1.0
 */
export type ServerHandle = unknown;

/**
 * File metadata returned by {@linkcode IFileSystem.stat}.
 *
 * @since 0.1.0
 */
export interface StatResult {
  /** Whether the path is a regular file. */
  readonly isFile: boolean;
  /** Whether the path is a directory. */
  readonly isDirectory: boolean;
  /** Size in bytes. */
  readonly size: number;
  /** Last modification time, when the runtime provides it. */
  readonly mtime?: Date;
}

/**
 * Runtime-agnostic file system operations. Absent on runtimes without file
 * system access (edge platforms).
 *
 * @since 0.1.0
 */
export interface IFileSystem {
  /**
   * Reads a file.
   *
   * @param path - File path
   * @returns The file contents
   */
  readFile(path: string): Promise<Uint8Array>;
  /**
   * Writes a file, creating it if absent.
   *
   * @param path - File path
   * @param data - Bytes to write
   */
  writeFile(path: string, data: Uint8Array): Promise<void>;
  /**
   * Returns file metadata.
   *
   * @param path - File path
   * @returns The stat result
   */
  stat(path: string): Promise<StatResult>;
  /**
   * Lists directory entries.
   *
   * @param path - Directory path
   * @returns Entry names
   */
  readdir(path: string): Promise<readonly string[]>;
  /**
   * Creates a directory.
   *
   * @param path - Directory path
   * @param options - Set `recursive` to create parents
   */
  mkdir(path: string, options?: { readonly recursive?: boolean }): Promise<void>;
  /**
   * Removes a file or directory.
   *
   * @param path - Path to remove
   * @param options - Set `recursive` to remove directories with contents
   */
  rm(path: string, options?: { readonly recursive?: boolean }): Promise<void>;
}

/**
 * Runtime services — every runtime-specific operation the framework needs,
 * abstracted behind one interface. Registered under `CAPABILITIES.RUNTIME`
 * by the RuntimePlugin, which is mandatory in every application.
 *
 * @example
 * ```typescript
 * const runtime = ctx.services.get<IRuntimeServices>(CAPABILITIES.RUNTIME);
 * const requestId = runtime.uuid();
 * ```
 * @since 0.1.0
 */
export interface IRuntimeServices {
  /**
   * Identifies the current runtime.
   *
   * @returns The runtime platform identifier
   */
  platform(): RuntimePlatform;
  /**
   * Returns the runtime version string.
   *
   * @returns The version (e.g. `"2.7.5"`)
   */
  version(): string;
  /**
   * Returns the host name, when the runtime exposes one.
   *
   * @returns The host name
   */
  hostname(): string;

  /**
   * Generates a UUID v4.
   *
   * @returns A random UUID
   */
  uuid(): string;
  /**
   * Generates cryptographically secure random bytes.
   *
   * @param length - Number of bytes
   * @returns The random bytes
   */
  randomBytes(length: number): Uint8Array;
  /** Web Crypto `SubtleCrypto` for cryptographic operations. */
  readonly subtle: SubtleCrypto;

  /**
   * Returns the current wall-clock time in milliseconds since the epoch.
   *
   * @returns Milliseconds since the Unix epoch
   */
  now(): number;
  /**
   * Returns a high-resolution monotonic timestamp in milliseconds, suitable
   * for measuring durations.
   *
   * @returns Monotonic milliseconds
   */
  hrtime(): number;
  /**
   * Schedules a one-shot callback.
   *
   * @param fn - Callback to invoke
   * @param ms - Delay in milliseconds
   * @returns Handle for {@linkcode clearTimeout}
   */
  setTimeout(fn: () => void, ms: number): TimerHandle;
  /**
   * Cancels a {@linkcode setTimeout}.
   *
   * @param handle - The timer handle
   */
  clearTimeout(handle: TimerHandle): void;
  /**
   * Schedules a repeating callback.
   *
   * @param fn - Callback to invoke
   * @param ms - Interval in milliseconds
   * @returns Handle for {@linkcode clearInterval}
   */
  setInterval(fn: () => void, ms: number): TimerHandle;
  /**
   * Cancels a {@linkcode setInterval}.
   *
   * @param handle - The timer handle
   */
  clearInterval(handle: TimerHandle): void;

  /** Environment variables. Always read env through this, never `process.env`. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /**
   * Terminates the process.
   *
   * @param code - Exit code (defaults to 0)
   * @returns Never returns
   */
  exit(code?: number): never;

  /** File system access; absent on runtimes without one (edge platforms). */
  readonly fs?: IFileSystem;
}

/**
 * HTTP server adapter provided by the runtime plugin. No other plugin may
 * create HTTP servers (AI_GUIDELINES §4.3).
 *
 * The contract is web-standard `fetch`-centric: `setHandler` installs the
 * request handler, `fetch` is the universal entry point callable without
 * `listen` (Cloudflare Workers), `listen` binds a real socket, and `close`
 * tears it down.
 *
 * @since 0.1.0
 */
export interface IHttpAdapter {
  /**
   * Installs the framework request handler. Called once at `start()` time,
   * after the middleware pipeline compiles and before any `fetch` or `listen`.
   *
   * @param handler - Handles a normalized request, produces a response
   */
  setHandler(handler: (request: IRequest) => Promise<IResponse>): void;
  /**
   * The universal web-standard entry point. Accepts a web `Request` and
   * returns a web `Response`. May be called without `listen` (e.g. Cloudflare
   * Workers where `export default { fetch: app.fetch }` is the deploy path).
   *
   * @param request - A web-standard `Request`
   * @returns A web-standard `Response`
   */
  fetch(request: Request): Promise<Response>;
  /**
   * Binds the adapter's `fetch` to a real TCP socket.
   *
   * @param port - TCP port to bind
   * @param hostname - Bind address (defaults to all interfaces)
   * @returns An opaque server handle (returned from `listen`, passed to `close`)
   */
  listen(port: number, hostname?: string): Promise<ServerHandle>;
  /**
   * Stops the server gracefully.
   *
   * @param handle - The server handle returned by `listen`
   */
  close(handle: ServerHandle): Promise<void>;
}
