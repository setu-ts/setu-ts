/**
 * Upload middleware — reads `multipart/form-data` through the request's
 * `formData()` accessor (M94b) and exposes files via `ctx.state` plus a typed
 * `getUploadedFile()` helper.
 *
 * @module
 */
import type {
  FormBody,
  FormFile,
  ILogger,
  IRequestContext,
  MiddlewareFunction,
} from '@setu-ts/common';
import {
  CAPABILITIES,
  formEncodingOf,
  httpStatusHintOf,
  parseFormBody,
  respondWithError,
} from '@setu-ts/common';
import type { UploadedFile, UploadMiddlewareOptions } from '../interfaces/index.ts';

/** Key used to store parsed uploads in `ctx.state`. */
const UPLOADS_STATE_KEY = 'storage-plugin:uploads';

/** Default max file size (10 MB). */
const DEFAULT_MAX_SIZE = 10 * 1024 * 1024;

/** Default field name. */
const DEFAULT_FIELDNAME = 'file';

/**
 * Default ceiling on the body this middleware will parse (50 MB).
 *
 * A CEILING, not a floor. The expression it replaces was
 * `Math.max(maxSize * 2, 50 * 1024 * 1024)` under a comment reading "cap at
 * 50 MB", which made 50 MB the minimum: any `maxSize` above 25 MB raised the
 * bound without limit, so a 100 MB per-file limit delivered a 60 MB body to the
 * handler unchecked (X8-3).
 */
const DEFAULT_MAX_BODY_BYTES = 50 * 1024 * 1024;

/**
 * Slack added to `maxSize` for multipart framing — the boundary delimiters,
 * per-part headers and CRLFs that wrap the file bytes. Generous on purpose: it
 * must never reject a payload whose FILE is within `maxSize`, because that
 * would refuse a legitimate upload.
 */
const MULTIPART_FRAMING_ALLOWANCE = 8 * 1024;

/**
 * Resolves the byte ceiling on the body this middleware will parse.
 *
 * `Math.min` against the ceiling is the whole fix: the bound follows `maxSize`
 * upward only until it reaches the ceiling the option documents.
 *
 * Both inputs are validated, because `NaN` propagates through `Math.min` and
 * every later `>` comparison against it is `false` — so a single
 * `maxSize: Number(process.env.MAX)` with an unset variable would silently
 * disable BOTH the body bound and the per-file limit, leaving the middleware
 * parsing an unbounded multipart body. Failing here surfaces it at route setup
 * with the option named, which is this repo's rule for a bad configuration.
 *
 * @param maxSize - Per-file limit in bytes
 * @param maxBodyBytes - Configured ceiling, or `undefined` for the default
 * @returns The effective bound in bytes
 * @throws {RangeError} If either value is not a finite, non-negative number
 */
export function resolveMaxBodyBytes(maxSize: number, maxBodyBytes?: number): number {
  assertByteLimit('maxSize', maxSize);
  if (maxBodyBytes !== undefined) {
    assertByteLimit('maxBodyBytes', maxBodyBytes);
  }
  const ceiling = maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  return Math.min(maxSize * 2 + MULTIPART_FRAMING_ALLOWANCE, ceiling);
}

/**
 * Refuses a byte limit that cannot bound anything.
 *
 * @param option - The option's name, so the message names what to fix
 * @param value - The configured value
 * @throws {RangeError} If the value is not a finite, non-negative number
 */
function assertByteLimit(option: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(
      `createUploadMiddleware: ${option} must be a finite, non-negative number (received ${value})`,
    );
  }
}

/**
 * Creates an upload middleware factory.
 *
 * Checks the declared `Content-Length`, reads the body once through
 * `ctx.request.bytes()` and caps that length against
 * {@linkcode resolveMaxBodyBytes} BEFORE the form is touched, then obtains the
 * form through the request's `formData()` accessor — or, when the request
 * omits that optional member (an out-of-repo `IRequest`), through the same
 * shared `parseFormBody` the accessor itself calls — and enforces
 * `maxSize`/`allowedMimeTypes`/`maxFiles` on the field's FILE parts before
 * storing the result under `'storage-plugin:uploads'` in `ctx.state`. Every
 * refusal short-circuits without calling `next`. Parsing is the shared one
 * parse (M94b): a `csrfFormMiddleware` that already read the same form ahead
 * of this middleware costs it nothing, because the accessor memoizes. The
 * policy (every bound and every refusal status) stayed here; only the parse
 * moved to `common`.
 *
 * A part carrying no `filename` under the field name is a plain form value in
 * the web standard's terms and is no longer reported as an upload — see the
 * CHANGELOG migration note.
 *
 * Refusals are answered `413` when something was too large — the request body
 * against {@linkcode resolveMaxBodyBytes}, or one file against `maxSize` — and
 * `400` when the request was genuinely malformed or otherwise unacceptable
 * (too many files, a disallowed MIME type, an unparseable body). Both size
 * refusals previously answered `400`, which told a client it had sent
 * something malformed when it had only sent something big.
 *
 * @param options - Middleware configuration
 * @returns A middleware function
 */
export function createUploadMiddleware(
  options?: UploadMiddlewareOptions,
): MiddlewareFunction {
  const fieldname = options?.fieldname ?? DEFAULT_FIELDNAME;
  const maxSize = options?.maxSize ?? DEFAULT_MAX_SIZE;
  const allowedMimeTypes = options?.allowedMimeTypes;
  const maxFiles = options?.maxFiles;
  const maxBodyBytes = resolveMaxBodyBytes(maxSize, options?.maxBodyBytes);

  return async (ctx, next) => {
    const ct = ctx.request.headers.get('content-type') ?? '';

    // Only process multipart requests — the ONE classifier (M94b), which also
    // case-folds where the private `includes()` it replaces did not. A
    // multipart type with no `boundary=` classifies as not-a-form and passes
    // through, like any other request this middleware would not parse.
    if (formEncodingOf(ct) !== 'multipart') {
      await next();
      return;
    }

    // Check Content-Length header early to reject oversized bodies before buffering.
    const clHeader = ctx.request.headers.get('content-length');
    if (clHeader !== null) {
      const contentLength = parseInt(clHeader, 10);
      if (!isNaN(contentLength) && contentLength > maxBodyBytes) {
        respondWithError(ctx, {
          status: 413,
          title: 'Request entity too large',
          detail: `Request body exceeds the maximum allowed size of ${maxBodyBytes} bytes`,
        });
        return;
      }
    }

    try {
      const body = await ctx.request.bytes();
      if (body.length === 0) {
        await next();
        return;
      }

      // Hard cap on buffered bytes — reject without parsing.
      if (body.length > maxBodyBytes) {
        respondWithError(ctx, {
          status: 413,
          title: 'Request entity too large',
          detail: `Request body exceeds the maximum allowed size of ${maxBodyBytes} bytes`,
        });
        return;
      }

      // ONE form parse (M94b): through the request's memoized accessor when
      // the request carries it, through the same shared `parseFormBody` when
      // it does not — the branch an out-of-repo `IRequest` takes. The guard
      // above guarantees this parse cannot reject with a `415`.
      const form: FormBody = ctx.request.formData !== undefined
        ? await ctx.request.formData()
        : parseFormBody(body, ct);

      // The field's FILE parts only. `typeof value !== 'string'` is exactly
      // the web standard's discriminator — a part is a file when it declared
      // a `filename`, even an EMPTY one (an empty file input sends
      // `filename=""`); a truthiness test on `filename` here would wrongly
      // drop that case. A part with NO filename under the field name is a
      // plain form value now and is no longer an upload (CHANGELOG).
      const files = form.getAll(fieldname).filter((value): value is FormFile =>
        typeof value !== 'string'
      );

      // Enforce maxFiles cap.
      if (maxFiles !== undefined && files.length > maxFiles) {
        respondWithError(ctx, {
          status: 400,
          title: 'Too many files',
          detail: `Maximum ${maxFiles} file(s) allowed`,
        });
        return;
      }

      // Validate each file.
      const uploaded: UploadedFile[] = [];
      for (const file of files) {
        if (file.data.length > maxSize) {
          respondWithError(ctx, {
            status: 413,
            title: 'File too large',
            detail: `Maximum size is ${maxSize} bytes`,
          });
          return;
        }
        if (allowedMimeTypes && !allowedMimeTypes.includes(file.mimeType)) {
          respondWithError(ctx, {
            status: 400,
            title: 'Invalid MIME type',
            detail: `Type '${file.mimeType}' not allowed`,
          });
          return;
        }
        uploaded.push({
          name: fieldname,
          filename: file.filename,
          data: file.data,
          mimeType: file.mimeType,
          size: file.data.length,
        });
      }

      // Store under state key.
      ctx.state.set(UPLOADS_STATE_KEY, uploaded);
    } catch (error) {
      // A REFUSED body is answered as the refusal, never as a malformed one
      // (V5-1). Since M90a the read above can reject rather than return:
      // `RuntimePlugin({ maxBodyBytes })` bounds it and rejects with a
      // 413-hinted `RequestBodyTooLargeError`. Reporting that as
      // `400 Failed to parse multipart body` named the wrong cause — the body
      // was never parsed — and the wrong remedy, since a client told its
      // multipart is malformed will re-send the same oversized upload. The
      // hint IS an `ErrorResponseInit`, so it is served through the same
      // responder and comes out in the application's configured format.
      const hint = httpStatusHintOf(error);
      if (hint !== undefined) {
        respondWithError(ctx, hint);
        return;
      }
      // A malformed multipart body → 400. The catch guards ONLY the parse and
      // validation above; `await next()` runs after it, so a downstream handler
      // failure is no longer reported as a malformed body (X8-1). A genuinely
      // malformed body is still diagnosable through the warn log.
      logMalformedBody(ctx, error);
      respondWithError(ctx, {
        status: 400,
        title: 'Bad Request',
        detail: 'Failed to parse multipart body',
      });
      return;
    }

    await next();
  };
}

/**
 * Logs a caught multipart parse/validation failure at `warn` level when a
 * logger is registered. Guarded so a missing or broken logger can never turn a
 * rejected upload into a crashed request.
 *
 * @param ctx - The request context (supplies the logger registry)
 * @param error - The caught error
 */
function logMalformedBody(ctx: IRequestContext, error: unknown): void {
  try {
    if (!ctx.services.has(CAPABILITIES.LOGGER)) {
      return;
    }
    const logger = ctx.services.get<ILogger>(CAPABILITIES.LOGGER);
    const err = error instanceof Error ? error : new Error(String(error));
    logger.warn('Failed to parse multipart body', {
      error: err.message,
      stack: err.stack,
    });
  } catch {
    // No safe channel remains — degrade silently.
  }
}

/**
 * Retrieves uploaded files for a given field name from `ctx.state`.
 *
 * @param ctx - The request context
 * @param fieldname - The form field name (default `'file'`)
 * @returns The uploaded files, or `undefined` if none found
 * @since 0.1.0
 */
export function getUploadedFile(
  ctx: { state: Map<string, unknown> },
  fieldname?: string,
): UploadedFile | undefined {
  const uploads = ctx.state.get(UPLOADS_STATE_KEY) as UploadedFile[] | undefined;
  if (!uploads || uploads.length === 0) return undefined;
  const fn = fieldname ?? DEFAULT_FIELDNAME;
  return uploads.find((u) => u.name === fn);
}
