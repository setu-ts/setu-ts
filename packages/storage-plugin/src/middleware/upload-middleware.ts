/**
 * Upload middleware — parses `multipart/form-data` and exposes files via
 * `ctx.state` plus a typed `getUploadedFile()` helper.
 *
 * @module
 */
import type { ILogger, IRequestContext, MiddlewareFunction } from '@setu-ts/common';
import { CAPABILITIES, respondWithError } from '@setu-ts/common';
import type { UploadedFile, UploadMiddlewareOptions } from '../interfaces/index.ts';
import { parseMultipart } from '../multipart/multipart-parser.ts';

/** Key used to store parsed uploads in `ctx.state`. */
const UPLOADS_STATE_KEY = 'storage-plugin:uploads';

/** Default max file size (10 MB). */
const DEFAULT_MAX_SIZE = 10 * 1024 * 1024;

/** Default field name. */
const DEFAULT_FIELDNAME = 'file';

/**
 * Creates an upload middleware factory.
 *
 * Reads the buffered `ctx.request.bytes()`, parses `multipart/form-data`,
 * enforces `maxSize`/`allowedMimeTypes`/`maxFiles`, then stores the result
 * under `'storage-plugin:uploads'` in `ctx.state`.  On validation failure it
 * returns a 400 short-circuit response (never calls `next`).
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
  // Upper bound on total buffered body bytes to prevent unbounded memory growth.
  const maxBodyBytes = Math.max(maxSize * 2, 50 * 1024 * 1024); // at least 2× max per file, cap at 50 MB

  return async (ctx, next) => {
    const ct = ctx.request.headers.get('content-type') ?? '';

    // Only process multipart requests.
    if (!ct.includes('multipart/form-data')) {
      await next();
      return;
    }

    // Check Content-Length header early to reject oversized bodies before buffering.
    const clHeader = ctx.request.headers.get('content-length');
    if (clHeader !== null) {
      const contentLength = parseInt(clHeader, 10);
      if (!isNaN(contentLength) && contentLength > maxBodyBytes) {
        respondWithError(ctx, {
          status: 400,
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
          status: 400,
          title: 'Request entity too large',
          detail: `Request body exceeds the maximum allowed size of ${maxBodyBytes} bytes`,
        });
        return;
      }

      const parts = parseMultipart(body, ct);

      // Filter to matching field names.
      const filtered = parts.filter((p) => p.name === fieldname);

      // Enforce maxFiles cap.
      if (maxFiles !== undefined && filtered.length > maxFiles) {
        respondWithError(ctx, {
          status: 400,
          title: 'Too many files',
          detail: `Maximum ${maxFiles} file(s) allowed`,
        });
        return;
      }

      // Validate each file.
      const uploaded: UploadedFile[] = [];
      for (const part of filtered) {
        if (part.data.length > maxSize) {
          respondWithError(ctx, {
            status: 400,
            title: 'File too large',
            detail: `Maximum size is ${maxSize} bytes`,
          });
          return;
        }
        if (allowedMimeTypes && !allowedMimeTypes.includes(part.mimeType)) {
          respondWithError(ctx, {
            status: 400,
            title: 'Invalid MIME type',
            detail: `Type '${part.mimeType}' not allowed`,
          });
          return;
        }
        uploaded.push({
          name: part.name,
          filename: part.filename ?? part.name,
          data: part.data,
          mimeType: part.mimeType,
          size: part.data.length,
        });
      }

      // Store under state key.
      ctx.state.set(UPLOADS_STATE_KEY, uploaded);
    } catch (error) {
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
