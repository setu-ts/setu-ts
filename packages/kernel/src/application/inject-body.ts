/**
 * Per-shape coercion of an {@linkcode InjectRequest} body (M95c §3.9).
 *
 * `inject()` used to JSON-stringify every non-string body, so a
 * `Uint8Array` arrived as `{"0":97,…}` and an `ArrayBuffer`, a `Blob` and a
 * `URLSearchParams` each arrived as the two bytes `{}` — destroying the input
 * while reporting status 200. The coercion is now explicit per shape, and any
 * shape OUTSIDE the union is refused by name rather than silently stringified,
 * because `InjectRequest.body` is reachable from JavaScript and from an
 * `unknown`-typed caller, where the type alone would not hold.
 *
 * Internal to the kernel — deliberately NOT exported from the barrel. The
 * union itself has ONE home, the published `InjectRequest.body`; this module
 * derives its alias from it so the two cannot drift.
 *
 * @module
 */
import type { InjectRequest } from './application.ts';

/**
 * The body shapes {@linkcode InjectRequest} carries — derived from the
 * published interface, which owns the literal union.
 *
 * @since 0.6.1
 */
export type InjectBody = NonNullable<InjectRequest['body']>;

/** What {@linkcode coerceInjectBody} resolves with. */
export interface CoercedInjectBody {
  /** The body's bytes; `undefined` when the caller sent no body. */
  readonly bytes: Uint8Array | undefined;
  /**
   * The content type to default to when the caller supplied none:
   * `application/x-www-form-urlencoded` for a `URLSearchParams`,
   * `application/json` for a string or a plain object, and NONE for the
   * byte-ish shapes — only the caller knows whether those bytes are multipart,
   * JSON, or an image, and guessing would make the form parse refuse them.
   */
  readonly defaultContentType: string | undefined;
}

/**
 * Coerces an injected body to the bytes the synthetic request carries.
 *
 * Bytes pass through unchanged, a `Blob` is awaited to bytes, a
 * `URLSearchParams` is serialised with its own `toString()`, and only a plain
 * object reaches `JSON.stringify` — an array, a `Date`, a class instance or
 * any other shape rejects with a `TypeError` naming the received type.
 *
 * @param body - The caller-supplied body, if any
 * @returns The coerced bytes and the content-type default for the shape
 * @throws {TypeError} When the body is outside the {@linkcode InjectBody} union
 * @since 0.6.1
 */
export async function coerceInjectBody(
  body: InjectBody | undefined,
): Promise<CoercedInjectBody> {
  if (body === undefined) {
    return { bytes: undefined, defaultContentType: undefined };
  }
  if (typeof body === 'string') {
    return { bytes: new TextEncoder().encode(body), defaultContentType: 'application/json' };
  }
  if (body instanceof URLSearchParams) {
    return {
      bytes: new TextEncoder().encode(body.toString()),
      defaultContentType: 'application/x-www-form-urlencoded',
    };
  }
  if (body instanceof Uint8Array) {
    return { bytes: body, defaultContentType: undefined };
  }
  if (body instanceof ArrayBuffer) {
    return { bytes: new Uint8Array(body), defaultContentType: undefined };
  }
  if (body instanceof Blob) {
    return { bytes: new Uint8Array(await body.arrayBuffer()), defaultContentType: undefined };
  }
  if (typeof body === 'object' && body !== null && isPlainObject(body)) {
    return {
      bytes: new TextEncoder().encode(JSON.stringify(body)),
      defaultContentType: 'application/json',
    };
  }
  throw new TypeError(refusalMessage(body));
}

/** A plain object: `Object.prototype` (or `null`) is its prototype. */
function isPlainObject(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Names the received value in the refusal, so the caller sees what was wrong. */
function refusalMessage(value: unknown): string {
  const received = value === null
    ? 'null'
    : typeof value === 'object'
    ? (Object.getPrototypeOf(value) as { constructor?: { name?: string } } | null)?.constructor
      ?.name ?? 'object'
    : typeof value;
  return (
    `inject() body must be a string, Uint8Array, ArrayBuffer, Blob, URLSearchParams, or a ` +
    `plain object; received ${received}. The previous behaviour silently JSON-stringified ` +
    `every other shape, which destroyed the value — pass bytes for a binary or multipart ` +
    `body, or a plain object for JSON.`
  );
}
