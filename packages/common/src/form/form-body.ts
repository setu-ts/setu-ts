/**
 * One form-body read for both form encodings.
 *
 * `parseFormBody` is the ONE parse every `IRequest.formData?()` producer
 * shares — the `parseJsonBody` precedent (X37-1): with one implementation in
 * `common`, the `@throws` contract holds at every producer and the three
 * cannot disagree about what a request carries. `formEncodingOf` is the ONE
 * content-type classifier both first-party form consumers read, replacing two
 * private `includes()` checks that had already drifted (one did no case
 * folding; the other lower-cased).
 *
 * The returned `FormBody` adopts the web `FormData` SEMANTICS — ordered
 * `getAll` for repeated names, file-versus-text discriminated on
 * `filename !== undefined`, repeated-name iteration in wire order — over a
 * framework-owned value shape. The web `File` itself is not adopted because
 * its byte access is asynchronous and copying: `parseMultipart` already hands
 * back its own `Uint8Array`, so wrapping it in a `File` would add a second
 * full copy per file part, held for the request's duration, on exactly the
 * upload path this abstraction exists to make cheaper.
 *
 * @module
 */

import { UnsupportedFormEncodingError } from '../errors/unsupported-form-encoding.ts';
import { parseContentType } from './content-type.ts';
import type { ParsedPart } from './multipart-parser.ts';
import { parseMultipart } from './multipart-parser.ts';

// Hoisted decoder — one per process, not one per parsed part (the
// `fetch-mapping` A1 precedent; `TextDecoder` construction is not free).
const decoder = new TextDecoder();

/** The two media types this module parses, matched exactly after case-folding. */
const MULTIPART_FORM_DATA = 'multipart/form-data';
const FORM_URLENCODED = 'application/x-www-form-urlencoded';

/**
 * The two request encodings a form body can carry.
 *
 * Returned by {@linkcode formEncodingOf}; a caller that wants to BRANCH on the
 * encoding (the CSRF verifier and the upload middleware both do) reads this
 * before touching the body, so a non-form request never reaches a throw.
 *
 * @since 0.6.0
 */
export type FormEncoding = 'urlencoded' | 'multipart';

/**
 * One file part of a form body: a field that declared a `filename` in its
 * `Content-Disposition`.
 *
 * `filename` is present exactly when the part declared one — an empty string
 * still counts, because an empty `<input type="file">` sends `filename=""`
 * and the web standard reports a (nameless) `File` for it. The bytes are the
 * parser's own synchronous view — no `await`, no copy. `size` is deliberately
 * omitted: `data.byteLength` is the same number.
 *
 * @since 0.6.0
 */
export interface FormFile {
  /** The client-provided file name (`Content-Disposition` `filename="…"`). */
  readonly filename: string;
  /** MIME type reported by the part's `Content-Type`, or its default. */
  readonly mimeType: string;
  /** The file bytes, synchronously. */
  readonly data: Uint8Array;
}

/**
 * One form value: a plain field string, or a {@linkcode FormFile}.
 *
 * The discriminator is `typeof value === 'string'` — the same test the web
 * standard's entry values answer to. Narrowing on it is a security decision
 * wherever a value is consumed as text: a client chooses whether a part
 * carries a `filename` freely.
 *
 * @since 0.6.0
 */
export type FormValue = string | FormFile;

/**
 * A parsed form body: the read-only view `IRequest.formData?()` resolves and
 * `parseFormBody` returns.
 *
 * Named `FormBody`, never `FormData`, so it cannot shadow the global. The web
 * standard's semantics are adopted; the write side (`set`/`append`/`delete`)
 * is not — a request body is a fact about the request, not a collection a
 * handler edits.
 *
 * @example
 * ```typescript
 * const form = await ctx.request.formData();
 * const token = form.get('_csrf');
 * if (typeof token !== 'string' || token === '') {
 *   // No usable token — the value was a file or absent.
 * }
 * ```
 * @since 0.6.0
 */
export interface FormBody {
  /**
   * Returns the FIRST value for a name, or `undefined` when the name is
   * absent — the web standard's `get`, with `undefined` (narrowable) in place
   * of `null`.
   *
   * @param name - The form field name
   * @returns The first value, or `undefined`
   */
  get(name: string): FormValue | undefined;
  /**
   * Returns every value for a name in wire order — the web standard's
   * `getAll`, so a repeated field (multi-select, multi-file) keeps the order
   * the client sent.
   *
   * The returned array is the parse's own READ view, not a defensive copy:
   * mutating it mutates what later `getAll` calls return. Treat it as
   * read-only (the `IResponse.snapshot()` precedent — a copy would allocate
   * on every read of a value most readers never touch).
   *
   * @param name - The form field name
   * @returns The values, empty when the name is absent
   */
  getAll(name: string): readonly FormValue[];
  /**
   * Iterates every `[name, value]` pair in wire order — the enumeration
   * primitive for reading a form whose field names the reader does not know
   * ahead of time (the hand-rolled `new URLSearchParams(body)` iteration this
   * accessor replaces).
   *
   * @returns An iterator over the name/value pairs
   */
  entries(): IterableIterator<[string, FormValue]>;
}

/**
 * Classifies a request content-type as one of the two form encodings.
 *
 * The media type is matched EXACTLY against the two supported types after
 * case-folding, and parameters are parsed separately through the shared
 * {@linkcode parseContentType} — which is also what `parseMultipart` reads its
 * `boundary` from, so the classifier and the parser cannot disagree about a
 * header. A substring search over the raw value accepted three shapes that are
 * not forms (each measured): a suffixed media type
 * (`application/x-www-form-urlencoded-v2`), a supported type appearing inside
 * an unrelated QUOTED parameter (`text/plain; note="…urlencoded"`), and
 * `boundary=` matching inside a different parameter NAME (`xboundary=q`).
 *
 * A `multipart/form-data` type carrying no `boundary` parameter — or one whose
 * value is empty — is `undefined`: the body is not parseable as a form, and
 * reporting an encoding that cannot be parsed would hand the caller a
 * guaranteed throw.
 *
 * Pure — this is the one classifier the upload middleware's multipart guard
 * and the CSRF verifier's form guard both read, replacing their private
 * `includes()` copies.
 *
 * @param contentType - The `content-type` header, or `null` when absent
 * @returns The encoding, or `undefined` when the type is not a parseable form
 * @example
 * ```typescript
 * const encoding = formEncodingOf(request.headers.get('content-type'));
 * if (encoding === undefined) return; // not a form — branch, don't parse
 * ```
 * @since 0.6.0
 */
export function formEncodingOf(contentType: string | null): FormEncoding | undefined {
  if (contentType === null) return undefined;
  const { mediaType, parameters } = parseContentType(contentType);
  if (mediaType === MULTIPART_FORM_DATA) {
    // A multipart body is unparseable without its delimiter, so a type
    // carrying no usable `boundary` is NOT a form: reporting an encoding here
    // would promise a parse that `parseMultipart` must then refuse.
    const boundary = parameters.get('boundary');
    return boundary !== undefined && boundary !== '' ? 'multipart' : undefined;
  }
  if (mediaType === FORM_URLENCODED) return 'urlencoded';
  return undefined;
}

/**
 * Parses one request body as a form — the ONE parse all three
 * `IRequest.formData?()` implementations share, and the function every
 * fallback path (a request without the optional accessor) calls directly.
 *
 * The urlencoded arm is `URLSearchParams` over the decoded body, which equals
 * the web answer value for value, including empty values and repeated names
 * in wire order. The multipart arm is the promoted `parseMultipart`, with a
 * part's file-versus-text nature taken from `filename !== undefined` and its
 * text parts decoded as UTF-8.
 *
 * @param body - The raw request bytes
 * @param contentType - The request's `content-type` header, or `null` when
 * absent
 * @returns The parsed form
 * @throws {UnsupportedFormEncodingError} When `contentType` is neither form
 * encoding — a JSON body, a missing content-type, or a multipart type with no
 * `boundary=`. A multipart BODY that is unparseable is NOT a throw: it yields
 * an empty `FormBody`, which is the promoted parser's released behaviour and
 * is documented as the accessor's limit rather than hidden behind a status.
 * @since 0.6.0
 */
export function parseFormBody(body: Uint8Array, contentType: string | null): FormBody {
  const encoding = formEncodingOf(contentType);
  if (encoding === undefined) {
    throw new UnsupportedFormEncodingError();
  }
  if (encoding === 'urlencoded') {
    return urlencodedForm(decoder.decode(body));
  }
  // Reachable only with a non-null content-type: `formEncodingOf` answers
  // `undefined` for `null`, and that arm already threw above.
  return multipartForm(parseMultipart(body, contentType as string));
}

/**
 * The accumulation both arms build: the values grouped by name for
 * `get`/`getAll`, and the flat pair list in wire order for `entries()`. The
 * web standard iterates pairs in the order they were APPENDED — an
 * interleaved repeat (`a=1, file, a=2`) must not regroup into
 * `a=1, a=2, file` — so `entries()` reads the flat list, never the groups.
 */
interface FormAccumulator {
  readonly grouped: Map<string, FormValue[]>;
  readonly flat: [string, FormValue][];
}

/** Accumulates one more value, preserving pair (wire) order. */
function appendValue(acc: FormAccumulator, name: string, value: FormValue): void {
  const existing = acc.grouped.get(name);
  if (existing === undefined) {
    acc.grouped.set(name, [value]);
  } else {
    existing.push(value);
  }
  acc.flat.push([name, value]);
}

/** Builds the read-only view over the accumulated values. */
function formBodyOf(acc: FormAccumulator): FormBody {
  return {
    get(name: string): FormValue | undefined {
      return acc.grouped.get(name)?.[0];
    },
    getAll(name: string): readonly FormValue[] {
      return acc.grouped.get(name) ?? [];
    },
    entries(): IterableIterator<[string, FormValue]> {
      return acc.flat[Symbol.iterator]();
    },
  };
}

/** Builds a form from an `application/x-www-form-urlencoded` body. */
function urlencodedForm(text: string): FormBody {
  const acc: FormAccumulator = { grouped: new Map(), flat: [] };
  for (const [name, value] of new URLSearchParams(text)) {
    appendValue(acc, name, value);
  }
  return formBodyOf(acc);
}

/** Builds a form from parsed multipart parts. */
function multipartForm(parts: readonly ParsedPart[]): FormBody {
  const acc: FormAccumulator = { grouped: new Map(), flat: [] };
  for (const part of parts) {
    // `filename !== undefined` is the web standard's file-versus-text
    // discriminator, and it is exactly what the parser records — a part with
    // no filename is a plain field value regardless of its Content-Type, and
    // an empty-string filename is still a file (an empty file input).
    const value: FormValue = part.filename === undefined
      ? decoder.decode(part.data)
      : { filename: part.filename, mimeType: part.mimeType, data: part.data };
    appendValue(acc, part.name, value);
  }
  return formBodyOf(acc);
}
