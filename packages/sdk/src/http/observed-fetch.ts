/**
 * `createObservedFetch` (M98n): an opt-in wrapper that counts outbound HTTP
 * attempts for the local diagnostics connector, plus the small plugin that
 * registers its source.
 *
 * Transparency is the controlling rule: the wrapped fetch sees exactly the
 * arguments and receiver it would see unwrapped, is called exactly once, and
 * its result or thrown value reaches the caller unchanged. Nothing about a
 * request or response other than the response's `status` is ever read.
 *
 * @module
 */

import type { IPlugin, IPluginContext } from 'jsr:@setu-ts/common@^0.7.0';

import type { IClientTiming } from './contracts.ts';
import { createDefaultFetch, type FetchTransport } from './default-fetch.ts';
import { createDefaultClientTiming } from './timing.ts';
import {
  compileOutboundAlias,
  OutboundHttpCollector,
  statusClassOf,
} from '../diagnostics/outbound-http-observations.ts';

/**
 * The capability token the returned plugin registers its source under.
 * Written as a literal so the SDK's `common` imports stay type-only; a test
 * pins it to `CAPABILITIES.OUTBOUND_HTTP_DIAGNOSTICS`.
 *
 * @internal
 */
export const OUTBOUND_HTTP_DIAGNOSTICS_TOKEN = 'outbound-http-diagnostics';

/**
 * The SDK's own version, reported as the plugin version. A literal rather
 * than a JSON import of the manifest (the SDK is browser-portable); a test
 * pins it to `packages/sdk/deno.json`.
 *
 * @internal
 */
export const SDK_VERSION = '0.7.0';

/**
 * The fixed, value-free construction and registration refusals.
 *
 * @internal
 */
export const OBSERVED_FETCH_ERRORS = {
  shape: 'createObservedFetch: options must be an object { alias, fetch?, timing? }.',
  extraKey: 'createObservedFetch: options accept only alias, fetch and timing.',
  fetch: 'createObservedFetch: fetch must be a function.',
  timing: 'createObservedFetch: timing must be an object whose now() returns a finite number.',
  random:
    'createObservedFetch: requires crypto.getRandomValues (Node >= 19, Deno, Bun, workerd, browsers).',
  otherApp:
    'createObservedFetch: this helper is already registered in another application; create one helper per application.',
} as const;

const OPTION_KEYS: ReadonlySet<string> = new Set(['alias', 'fetch', 'timing']);

/**
 * Options for {@linkcode createObservedFetch}.
 *
 * @since 0.8.0
 */
export interface ObservedFetchOptions {
  /**
   * The approved, non-secret display label for this helper: 1–64 UTF-8
   * bytes, no control characters. Never derive it from a destination; it is
   * disclosed to a paired devtool as written.
   */
  readonly alias: string;
  /**
   * The fetch to wrap. Defaults to the SDK's call-time `globalThis.fetch`.
   * A wrapped fetch should not depend on its receiver; prefer
   * `(input, init) => fetch(input, init)`.
   */
  readonly fetch?: (input: RequestInfo, init?: RequestInit) => Promise<Response>;
  /**
   * The monotonic clock, called as `timing.now()` — never detached. Defaults
   * to {@linkcode createDefaultClientTiming}. Probed once at construction.
   */
  readonly timing?: Pick<IClientTiming, 'now'>;
}

/**
 * The helper {@linkcode createObservedFetch} returns.
 *
 * @since 0.8.0
 */
export interface ObservedFetch {
  /**
   * The observed fetch. Pass it to `ClientOptions.fetch`,
   * `SseClientOptions.fetch`, or call it directly.
   */
  readonly fetch: (input: RequestInfo, init?: RequestInit) => Promise<Response>;
  /**
   * Registers this helper's diagnostics source under
   * `CAPABILITIES.OUTBOUND_HTTP_DIAGNOSTICS` and closes it on shutdown.
   * Register it in exactly one application.
   */
  readonly plugin: IPlugin;
}

/** Draws the per-helper plugin-name nonce: 16 random bytes, hex-encoded. */
function drawNonce(): string {
  const crypto = (globalThis as { crypto?: { getRandomValues?: unknown } }).crypto;
  if (crypto === undefined || typeof crypto.getRandomValues !== 'function') {
    throw new TypeError(OBSERVED_FETCH_ERRORS.random);
  }
  const bytes = new Uint8Array(16);
  (crypto as { getRandomValues(array: Uint8Array): Uint8Array }).getRandomValues(bytes);
  let hex = '';
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

/** Validates and returns the timing object, probing `now()` once as a method. */
function compileTiming(timing: unknown): Pick<IClientTiming, 'now'> {
  if (timing === undefined) {
    return createDefaultClientTiming();
  }
  if (typeof timing !== 'object' || timing === null) {
    throw new TypeError(OBSERVED_FETCH_ERRORS.timing);
  }
  const clock = timing as Pick<IClientTiming, 'now'>;
  let reading: unknown;
  try {
    reading = clock.now();
  } catch {
    throw new TypeError(OBSERVED_FETCH_ERRORS.timing);
  }
  if (typeof reading !== 'number' || !Number.isFinite(reading)) {
    throw new TypeError(OBSERVED_FETCH_ERRORS.timing);
  }
  return clock;
}

/** Reads a resolved value's status class; any fault answers `other`. */
function statusOf(value: unknown): ReturnType<typeof statusClassOf> {
  try {
    if (typeof value !== 'object' || value === null) {
      return 'other';
    }
    return statusClassOf((value as { status?: unknown }).status);
  } catch {
    return 'other';
  }
}

/**
 * Wraps a fetch so its attempts are counted for the local diagnostics
 * connector (M98n).
 *
 * Calling this IS the opt-in: build the helper only when a devtool
 * composition is present, and register `plugin` in that application. The
 * wrapper records that an attempt started, whether it resolved or failed,
 * the response's status class and its time to headers — nothing else. It
 * never reads the URL, headers, body, signal or error.
 *
 * Deliberate departure: a wrapped fetch that throws SYNCHRONOUSLY is rethrown
 * synchronously, although the return type is a promise — the wrapper must
 * not change the behavior of the application code it wraps.
 *
 * @param options - The alias, and optionally the fetch and clock
 * @returns The observed `fetch` and its registration `plugin`
 * @throws {TypeError} For malformed options, a failing clock probe, or no
 * `crypto.getRandomValues` — each with a fixed message naming no value
 * @throws {RangeError} For an alias outside 1–64 UTF-8 bytes or carrying a
 * control character
 * @example
 * ```typescript
 * const observed = createObservedFetch({ alias: 'payments-api' });
 * const client = createClient({ baseUrl: 'https://payments.example', fetch: observed.fetch });
 * ```
 * @since 0.8.0
 */
export function createObservedFetch(options: ObservedFetchOptions): ObservedFetch {
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new TypeError(OBSERVED_FETCH_ERRORS.shape);
  }
  for (const key of Object.keys(options)) {
    if (!OPTION_KEYS.has(key)) {
      throw new TypeError(OBSERVED_FETCH_ERRORS.extraKey);
    }
  }
  const alias = compileOutboundAlias(options.alias);
  const supplied: unknown = options.fetch;
  if (supplied !== undefined && typeof supplied !== 'function') {
    throw new TypeError(OBSERVED_FETCH_ERRORS.fetch);
  }
  const inner: FetchTransport = (supplied as FetchTransport | undefined) ?? createDefaultFetch();
  const timing = compileTiming(options.timing);
  const nonce = drawNonce();
  const collector = new OutboundHttpCollector(alias, timing);

  // Method shorthand: a dynamic `this` and NOT constructible, like `fetch`.
  const methods = {
    fetch(this: unknown, ...args: Parameters<FetchTransport>): Promise<Response> {
      // Forward the caller's receiver (the SDK client, for instance), except
      // the helper object itself: a direct `observed.fetch(url)` would hand
      // it — and its plugin — to the wrapped fetch, and the platform fetch
      // throws `Illegal invocation` on workerd with that receiver.
      const receiver = this === observed ? undefined : this;
      const token = collector.begin();
      let result: unknown;
      try {
        result = Reflect.apply(inner, receiver, args);
      } catch (error) {
        collector.settle(token, false, 'other');
        throw error;
      }
      // Adopt the value as `await` would. `Promise.resolve` reads a native
      // promise's `constructor`, which can throw; unwrapped, that fault only
      // surfaces at the caller's `await`, so it becomes a rejection with the
      // identical value here — recorded as a failure, never a synchronous
      // throw and never a permanently in-flight attempt.
      let adopted: Promise<Response>;
      try {
        adopted = Promise.resolve(result as Response | PromiseLike<Response>);
      } catch (error) {
        collector.settle(token, false, 'other');
        return Promise.reject(error);
      }
      // A DERIVED promise, never a side branch: a dropped rejection is still
      // reported to the host exactly once (the M98i lesson).
      return adopted.then(
        (value) => {
          collector.settle(token, true, statusOf(value));
          return value;
        },
        (reason: unknown) => {
          collector.settle(token, false, 'other');
          throw reason;
        },
      );
    },
  };

  let registeredApp: unknown;
  const plugin: IPlugin = Object.freeze({
    name: `outbound-http-diagnostics-${nonce}`,
    version: SDK_VERSION,
    register(ctx: IPluginContext): void {
      if (registeredApp !== undefined) {
        if (registeredApp !== ctx.app) {
          throw new Error(OBSERVED_FETCH_ERRORS.otherApp);
        }
        // The same application registering again: its registry and close
        // hooks survive a failed start's rollback, so only reopen. (The kernel
        // today refuses such a retry once RuntimePlugin re-registers
        // `runtime`, so this is tolerance, not a working recovery path.)
        collector.reopen();
        return;
      }
      registeredApp = ctx.app;
      collector.reopen();
      ctx.services.register(OUTBOUND_HTTP_DIAGNOSTICS_TOKEN, collector.source, { multi: true });
      ctx.lifecycle.onClose(() => collector.close());
    },
  });

  const observed: ObservedFetch = Object.freeze({ fetch: methods.fetch, plugin });
  return observed;
}
