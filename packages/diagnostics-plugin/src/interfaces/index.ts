/**
 * Public contracts for the local diagnostics connector — the plugin factory,
 * its options, and the native client helper's types.
 *
 * These are the ONLY types this package exports besides the two factories.
 * Protocol, crypto, session, and limit internals are not public surface.
 *
 * @module
 */

import type {
  ConfigDiagnosticsSnapshot,
  DiagnosticsBatch,
  DiagnosticsSnapshot,
  HealthDiagnosticsSnapshot,
  IPlugin,
  QueueDiagnosticsBatch,
  TraceDiagnosticsBatch,
} from '@setu-ts/common';

/**
 * Options for {@linkcode DiagnosticsPlugin} — all required, all explicit.
 *
 * There is no environment fallback: importing the package, registering
 * unrelated plugins, or setting a development environment variable never
 * exposes an endpoint. The credentials are the fresh per-launch pair the
 * trusted native launcher generated and handed to the application's
 * composition in memory — never a value the plugin reads from the
 * environment, a file, or a URL.
 *
 * @since 0.8.0
 */
export interface DiagnosticsPluginOptions {
  /**
   * The explicit opt-in, and deliberately the LITERAL `true` rather than a
   * `boolean`: this is an acknowledgement, not a toggle.
   *
   * There is no disabled mode. `enabled: false` has never activated
   * anything — it is refused at composition time so a half-configured
   * development launch fails loudly instead of half-starting — so a
   * caller reaching for the obvious
   * `enabled: !isProduction` would not get an inert connector, they would
   * get an application that throws at composition and never boots in
   * production. Typing the literal makes that a COMPILE error instead, and
   * points at the only correct shape: decide whether to construct the
   * plugin at all.
   *
   * @example
   * ```typescript
   * // Not a toggle — decide by INCLUSION, ideally from a development-only
   * // entry point that production never imports.
   * const plugins = [RuntimePlugin()];
   * if (devtoolCredentials !== undefined) {
   *   plugins.push(DiagnosticsPlugin({ enabled: true, port, sessionId, sessionKey }));
   * }
   * ```
   */
  readonly enabled: true;
  /**
   * The IPv4 loopback port the runtime-owned listener binds. Only
   * `1024`–`65535` is accepted; there is no port auto-selection and no
   * fallback address.
   */
  readonly port: number;
  /**
   * The 16-byte session ID as 32 lowercase hex characters, generated fresh
   * by the trusted launcher for this launch.
   */
  readonly sessionId: string;
  /**
   * The 32-byte session key, generated fresh by the trusted launcher for
   * this launch. Copied into a non-extractable Web Crypto HMAC-SHA-256 key
   * at activation; the plugin's temporary copy is zeroed after import.
   */
  readonly sessionKey: Uint8Array;
  /**
   * Session lifetime in milliseconds, measured on the runtime's monotonic
   * clock from activation. Defaults to 900,000 (15 minutes); accepted range
   * is 1 through 3,600,000.
   */
  readonly ttlMs?: number;
}

/**
 * The diagnostics connector plugin: an {@linkcode IPlugin} that additionally
 * answers {@linkcode revoke}, so the composition that created it can end the
 * local session without stopping the owning application.
 *
 * @example
 * ```typescript
 * const diagnostics = DiagnosticsPlugin({ enabled: true, port: 4919, sessionId, sessionKey });
 * const app = createApplication({ plugins: [RuntimePlugin(), diagnostics], diagnostics: {} });
 * await app.start();
 * // … later, without stopping the application:
 * await diagnostics.revoke();
 * ```
 * @since 0.8.0
 */
export interface IDiagnosticsPlugin extends IPlugin {
  /**
   * Immediately disables authorization, discards key references, and closes
   * the runtime-owned listener. Idempotent: repeated and concurrent calls
   * await the same cleanup. Does NOT stop the parent application or M98a's
   * in-process reader. A revoked instance cannot be reactivated; pairing
   * again requires a fresh development application launch.
   */
  revoke(): Promise<void>;
}

/**
 * The native client helper's factory options. Every dependency is injected:
 * the helper uses web-standard `fetch` and `SubtleCrypto` supplied by its
 * caller and never reads ambient runtime globals.
 *
 * @since 0.8.0
 */
export interface DiagnosticsClientOptions {
  /**
   * Exactly `http://127.0.0.1:<port>` — no credentials, path, query, or
   * fragment. Any other endpoint is refused before the first request.
   */
  readonly endpoint: string;
  /**
   * The 32 lowercase hex characters of the launch's session ID.
   */
  readonly sessionId: string;
  /**
   * The 32 launch bytes of the session key. Imported once as a
   * non-extractable HMAC-SHA-256 key; the helper's temporary copy is zeroed
   * after import.
   */
  readonly sessionKey: Uint8Array;
  /**
   * The Web Crypto `SubtleCrypto` used for every MAC and digest operation.
   */
  readonly subtle: SubtleCrypto;
  /**
   * The web-standard `fetch` used for every request. Callers in framework
   * applications bind `IRuntimeServices`-provided or platform fetch here.
   */
  readonly fetch: typeof fetch;
  /**
   * The timing port used for the fixed 5-second request deadline:
   * `{ setTimeout(fn, ms): unknown; clearTimeout(handle): void }`. Callers
   * in framework applications bind `IRuntimeServices.setTimeout` /
   * `clearTimeout` here. All deadlines are cleared after completion or
   * {@linkcode IDiagnosticsClient.close}.
   */
  readonly timing: {
    setTimeout(fn: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
  };
}

/**
 * The native diagnostics client: performs the signed status pairing
 * exchange automatically before the first data operation, then serves
 * bounded snapshot and event reads.
 *
 * Calls are serialized and reserve unique, strictly increasing sequence
 * numbers; a number is never reused, including after a network failure.
 * Failed initial pairing is terminal: discard the client (and the session)
 * and relaunch rather than accepting another server under the same identity.
 *
 * @since 0.8.0
 */
export interface IDiagnosticsClient {
  /**
   * Reads the current application-composition snapshot through the signed
   * protocol. Performs the `/v1/status` pairing exchange first if the
   * session has not yet been bound to the application instance.
   *
   * @returns The frozen M98a snapshot projection
   * @throws {Error} When the client is closed, pairing failed terminally,
   * the response cannot be verified, or the peer violates the protocol
   */
  snapshot(): Promise<DiagnosticsSnapshot>;
  /**
   * Reads the next bounded batch of execution events after `after`.
   *
   * @param after - Sequence cursor; `0` starts at the oldest retained record
   * @param limit - Maximum events, 1–128 (default 128)
   * @returns The frozen M98a event batch
   * @throws {Error} Under the same conditions as {@linkcode snapshot}
   */
  read(after: number, limit?: number): Promise<DiagnosticsBatch>;
  /**
   * Reads the minimized health observations through the signed protocol
   * (M98d). Performs the `/v1/status` pairing exchange first if the session
   * has not yet been bound.
   *
   * The inspector support manifest negotiated during pairing decides the
   * answer: when it reports the health inspector as unsupported, a frozen
   * typed `unsupported` snapshot is returned WITHOUT sending an addon
   * request. When supported, the authenticated `/v1/health` exchange is
   * performed and its exact DTO is validated before being returned.
   *
   * @returns The frozen health snapshot projection
   * @throws {Error} Under the same conditions as {@linkcode snapshot}
   * @since 0.8.0
   */
  health(): Promise<HealthDiagnosticsSnapshot>;
  /**
   * Reads the value-free configuration provenance through the signed
   * protocol (M98e). Performs the `/v1/status` pairing exchange first if the
   * session has not yet been bound.
   *
   * The inspector support manifest negotiated during pairing decides the
   * answer: when it reports the configuration inspector as unsupported, a
   * frozen typed `unsupported` snapshot is returned WITHOUT sending an addon
   * request. When supported, the authenticated `/v1/config` exchange is
   * performed and its exact DTO is validated before being returned. The
   * snapshot never carries a configuration value, hash, length, or path.
   *
   * @returns The frozen configuration provenance projection
   * @throws {Error} Under the same conditions as {@linkcode snapshot}
   * @since 0.8.0
   */
  configuration(): Promise<ConfigDiagnosticsSnapshot>;
  /**
   * Reads the next bounded page of queue attempt observations, plus every
   * queue source's status and latest depths, through the signed protocol
   * (M98f). Performs the `/v1/status` pairing exchange first if the session
   * has not yet been bound.
   *
   * The cursor is the connector's merge cursor: `0` starts at the oldest
   * retained attempt, and the returned `next` continues from there. When the
   * negotiated inspector manifest reports the queue inspector as unsupported,
   * a frozen typed `unsupported` batch echoing the cursor is returned WITHOUT
   * sending an addon request.
   *
   * @param after - Merge cursor; `0` starts at the oldest retained attempt
   * @param limit - Maximum attempts, 1–128 (default 128)
   * @returns The frozen queue batch projection
   * @throws {Error} For invalid arguments, and under the same conditions as
   * {@linkcode snapshot}
   * @since 0.8.0
   */
  queues(after: number, limit?: number): Promise<QueueDiagnosticsBatch>;
  /**
   * Reads the next bounded page of completed, sampled span observations
   * through the signed protocol (M98g). Performs the `/v1/status` pairing
   * exchange first if the session has not yet been bound.
   *
   * The cursor follows the M98a contract: `0` starts at the oldest retained
   * span, `lost` is per batch, and an empty page echoes the cursor. When the
   * negotiated inspector manifest reports the trace inspector as unsupported,
   * a frozen typed `unsupported` batch echoing the cursor is returned WITHOUT
   * sending an addon request.
   *
   * @param after - Sequence cursor; `0` starts at the oldest retained span
   * @param limit - Maximum spans, 1–128 (default 128)
   * @returns The frozen trace batch projection
   * @throws {Error} For invalid arguments, and under the same conditions as
   * {@linkcode snapshot}
   * @since 0.8.0
   */
  traces(after: number, limit?: number): Promise<TraceDiagnosticsBatch>;
  /**
   * Closes the client: aborts pending fetches, drops key references, and
   * rejects subsequent calls with a fixed error. Idempotent.
   */
  close(): void;
}
