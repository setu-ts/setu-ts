/**
 * Internal publish-options validation — the ONE validator every public publish
 * entry runs before a transport is touched (M106 §3.4).
 *
 * Two properties are load-bearing:
 *
 * - **Every refusal is a `RangeError` delivered as a REJECTED promise.** A
 *   publish method that returns a `Promise` must never throw synchronously
 *   (the M52b class), so a caller using `.catch()` cannot miss it.
 * - **The caller's `options` is read exactly once into a frozen copy**, and only
 *   that copy is read afterwards, so a getter or `Proxy` cannot answer the
 *   validator one value and the transport another (the M98e copy-once class).
 *
 * Nothing here is exported from the package barrel: this validator is internal,
 * shared by the seven brokers and the two decorators. The RULES it enforces —
 * the id rule, the header name/value rules and the reserved-name tables — live
 * in `@setu-ts/common`, so the Cloudflare Workers envelope reader can enforce
 * the same ones without importing this package (§2.2).
 *
 * @module
 */

import type { ParsedPublishOptions } from '@setu-ts/common';
import { DEDUPLICATION_ID_HEADER, ORDERING_KEY_HEADER, parsePublishOptions } from '@setu-ts/common';

/** Internal outbox intent: accepting a publish requires a bound route. @since 0.14.0 */
export const PUBLISH_REQUIRE_ROUTE: unique symbol = Symbol('publish-require-route');
/**
 * Internal registry: a broker that can only honour a required route with
 * publisher confirms registers a probe here; a facade registers one that
 * forwards to its inner broker. A WeakMap rather than a symbol-keyed member,
 * so nothing appears on the brokers' public declarations.
 */
const ROUTED_PUBLISH_PROBES = new WeakMap<object, () => boolean | undefined>();

/**
 * Registers whether `broker` can confirm a required route.
 * @param broker - The broker or facade instance
 * @param probe - Answers at call time; `undefined` means not applicable
 * @returns Nothing
 * @throws Never
 * @since 0.14.0
 * @internal
 */
export function registerRoutedPublish(broker: object, probe: () => boolean | undefined): void {
  ROUTED_PUBLISH_PROBES.set(broker, probe);
}

/**
 * Whether `broker` can confirm a required route: `false` only for a broker
 * that needs publisher confirms and has none; `undefined` when not applicable.
 * @param broker - The (possibly wrapped) broker
 * @returns The broker's answer, or undefined
 * @throws Never
 * @since 0.14.0
 * @internal
 */
export function routedPublishAvailable(broker: object): boolean | undefined {
  return ROUTED_PUBLISH_PROBES.get(broker)?.();
}

/** The validated, frozen form of caller-supplied publish options. @internal */
export type ValidatedPublishOptions = ParsedPublishOptions;

/**
 * Reads and validates caller publish options into a frozen copy.
 *
 * Every RULE, and the copy-once read, is `common`'s `parsePublishOptions` — the
 * one implementation `cloudflare-plugin`'s Workers broker uses too. This
 * wrapper exists for the delivery shape: every refusal arrives as a REJECTED
 * promise, never a synchronous throw from a `Promise`-returning publish entry
 * (the M52b class).
 *
 * @param options - The caller's options, or `undefined`
 * @returns The frozen validated copy
 * @throws {RangeError} As a rejected promise, naming the field and the rule
 * @internal
 */
// `async` here is load-bearing, not a forgotten await: it is what turns the
// synchronous throw below into a REJECTED promise.
// eslint-disable-next-line require-await
export async function validatePublishOptions(options: unknown): Promise<ValidatedPublishOptions> {
  return parsePublishOptions(options);
}

/**
 * Builds the transport header record from the validated copy, the ordering and
 * de-duplication headers, and the framework's own headers.
 *
 * Framework headers are written LAST, so a caller can never overwrite one (the
 * reserved-name rule already refuses the attempt).
 *
 * @param validated - The frozen copy returned by {@linkcode validatePublishOptions}
 * @param frameworkHeaders - Framework-owned headers (for example `traceparent`)
 * @returns A fresh header record to hand the transport
 * @internal
 */
export function buildTransportHeaders(
  validated: ValidatedPublishOptions,
  frameworkHeaders: Readonly<Record<string, string>>,
): Record<string, string> {
  const headers: Record<string, string> = { ...validated.headers };
  if (validated.orderingKey !== undefined) {
    headers[ORDERING_KEY_HEADER] = validated.orderingKey;
  }
  if (validated.deduplicationId !== undefined) {
    headers[DEDUPLICATION_ID_HEADER] = validated.deduplicationId;
  }
  for (const [key, value] of Object.entries(frameworkHeaders)) {
    Object.defineProperty(headers, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return headers;
}
