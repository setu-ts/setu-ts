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
import type { FormBody, HttpMethod, IPrincipal, IRequest, ITenant } from '@setu-ts/common';
import { installRequestIdentityGuard, parseFormBody, parseJsonBody } from '@setu-ts/common';

import type { InjectRequest } from './application.ts';

/**
 * The body shapes {@linkcode InjectRequest} carries — derived from the
 * published interface, which owns the literal union.
 *
 * @since 0.7.0
 */
export type InjectBody = NonNullable<InjectRequest['body']>;

/** What {@linkcode coerceInjectBody} resolves with. */
export interface CoercedInjectBody {
  /** The body's bytes; `undefined` when the caller sent no body. */
  readonly bytes: Uint8Array | undefined;
  /**
   * The content type to default to when the caller supplied none:
   * `application/x-www-form-urlencoded` for a `URLSearchParams`,
   * `application/json` for a string or a plain object, a `Blob`'s own `type`
   * when that string is non-empty (matching the platform, whose
   * `new Request(url, { body: blob })` sets the header from it and omits it
   * when the blob has none), and NONE for a `Uint8Array` or an `ArrayBuffer`
   * — those bytes carry no declared type, and guessing would make the form
   * parse refuse them.
   */
  readonly defaultContentType: string | undefined;
}

/**
 * Coerces an injected body to the bytes the synthetic request carries.
 *
 * Bytes pass through with their exact contents — copied, never aliased to the
 * caller's `Uint8Array` or `ArrayBuffer`, since `bytes()` hands the result
 * straight to the handler — a `Blob` is awaited to bytes, a `URLSearchParams`
 * is serialised with its own `toString()`, and only a plain object reaches
 * `JSON.stringify`. An array, a `Date`, a class instance or any other shape
 * rejects with a `TypeError` naming the received type.
 *
 * @param body - The caller-supplied body, if any
 * @returns The coerced bytes and the content-type default for the shape
 * @throws {TypeError} When the body is outside the {@linkcode InjectBody} union
 * @since 0.7.0
 */
export async function coerceInjectBody(body: InjectBody | undefined): Promise<CoercedInjectBody> {
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
    // A COPY, not the caller's array. `bytes()` hands this straight to the
    // handler, so aliasing would let a handler that mutates the body it read
    // corrupt the fixture the test passed in — and a fixture reused across two
    // injected requests would carry the first request's mutation into the
    // second. `slice()` also guarantees a plain ArrayBuffer-backed view, which
    // `BodyInit` requires and a SharedArrayBuffer-backed argument would not be.
    return { bytes: body.slice(), defaultContentType: undefined };
  }
  if (body instanceof ArrayBuffer) {
    // `new Uint8Array(buffer)` is a VIEW over the caller's buffer, not a copy —
    // same aliasing hazard as above, one indirection further out.
    return { bytes: new Uint8Array(body.slice(0)), defaultContentType: undefined };
  }
  if (body instanceof Blob) {
    // A Blob DECLARES its type in `.type`, so it contributes that as the
    // content-type default — exactly what the platform does for
    // `new Request(url, { body: blob })`, header omitted when the type is
    // empty. The bare byte shapes stay default-free: bytes alone say nothing
    // about their encoding, which is why an injected multipart Blob used to
    // answer 500 (`UnsupportedFormEncodingError`) where the same Blob through
    // `fetch()` answered 200.
    return {
      bytes: new Uint8Array(await body.arrayBuffer()),
      defaultContentType: body.type.length > 0 ? body.type : undefined,
    };
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
  const received =
    value === null
      ? 'null'
      : typeof value === 'object'
        ? ((Object.getPrototypeOf(value) as { constructor?: { name?: string } } | null)?.constructor
            ?.name ?? 'object')
        : typeof value;
  return (
    `inject() body must be a string, Uint8Array, ArrayBuffer, Blob, URLSearchParams, or a ` +
    `plain object; received ${received}. The previous behaviour silently JSON-stringified ` +
    `every other shape, which destroyed the value — pass bytes for a binary or multipart ` +
    `body, or a plain object for JSON.`
  );
}

/**
 * The {@linkcode IRequest} an `inject()` call dispatches. A class rather than
 * an object literal so the identity guard sits on its prototype, as on the
 * runtime's served request: an injected request and a served one guard
 * `user`, `tenant` and `locale` the same way.
 *
 * @since 0.11.0
 * @internal
 */
export class InjectedRequest implements IRequest {
  readonly method: HttpMethod;
  readonly url: string;
  readonly headers: Headers;
  // `declare`: absent, not `undefined`, when the caller supplied none — the
  // shape the object literal this replaced had.
  declare readonly ip?: string;
  declare readonly raw?: Request;
  // `declare`, never class fields: an own property would shadow the guard.
  declare user?: IPrincipal;
  declare tenant?: ITenant;
  declare locale?: string;
  readonly #bodyBytes: Uint8Array | undefined;
  // The form read is memoized like `json()`'s: the in-flight promise is
  // cached (a rejection with it), so two middleware reading the same
  // injected body trigger one parse, and a body that is not a form keeps
  // rejecting identically on a retry.
  #form: Promise<FormBody> | undefined;

  /**
   * @param method - The request method
   * @param url - The absolute request URL
   * @param headers - The request headers (already the inject's own copy)
   * @param bodyBytes - The coerced body, or `undefined` when none was sent
   * @param ip - The caller-supplied client address, if any
   * @param raw - The web `Request` the handler may inspect, if it could be built
   */
  constructor(
    method: HttpMethod,
    url: string,
    headers: Headers,
    bodyBytes: Uint8Array | undefined,
    ip: string | undefined,
    raw: Request | undefined,
  ) {
    // Guarded on the prototype like the runtime's served request, so an
    // injected and a served request guard identity the same way. Installed by
    // the first construction (idempotent after that), not at import.
    installRequestIdentityGuard(InjectedRequest.prototype);
    this.method = method;
    this.url = url;
    this.headers = headers;
    this.#bodyBytes = bodyBytes;
    if (ip !== undefined) (this as { ip?: string }).ip = ip;
    if (raw !== undefined) (this as { raw?: Request }).raw = raw;
  }

  get path(): string {
    return new URL(this.url).pathname;
  }

  json<T>(): Promise<T> {
    // The shared parse (X37-1): a malformed body rejects with the
    // `400`-branded MalformedRequestBodyError, so `inject()` observes the
    // same failure the served path produces. The empty-body arm keeps its
    // `{}` default — an in-process inject that sent no body is not a
    // malformed body.
    const bodyBytes = this.#bodyBytes;
    return Promise.resolve().then(
      () =>
        parseJsonBody(bodyBytes === undefined ? '{}' : new TextDecoder().decode(bodyBytes)) as T,
    );
  }

  text(): Promise<string> {
    const bodyBytes = this.#bodyBytes;
    return Promise.resolve(bodyBytes === undefined ? '' : new TextDecoder().decode(bodyBytes));
  }

  bytes(): Promise<Uint8Array> {
    return Promise.resolve(this.#bodyBytes ?? new Uint8Array(0));
  }

  formData(): Promise<FormBody> {
    // The shared parse (M94b): a non-form content-type rejects with the
    // `415`-branded UnsupportedFormEncodingError, so an injected request
    // observes what a served request observes. A `Uint8Array` or an
    // `ArrayBuffer` sets NO default content type (M95c §3.9), so an
    // injected multipart in those shapes must supply its own — exactly
    // what a served request requires. A `Blob` supplies it from `.type`
    // (M99c), as the platform does.
    this.#form ??= Promise.resolve().then(() =>
      parseFormBody(this.#bodyBytes ?? new Uint8Array(0), this.headers.get('content-type')),
    );
    return this.#form;
  }
}
