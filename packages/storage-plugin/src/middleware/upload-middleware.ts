/**
 * Upload middleware — parses `multipart/form-data` and exposes files via
 * `ctx.state` plus a typed `getUploadedFile()` helper.
 *
 * @module
 */
import type { MiddlewareFunction } from '@setu-ts/common';
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
        return ctx.response.status(400).json({
          error: 'Request entity too large',
          detail: `Request body exceeds the maximum allowed size of ${maxBodyBytes} bytes`,
        });
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
        return ctx.response.status(400).json({
          error: 'Request entity too large',
          detail: `Request body exceeds the maximum allowed size of ${maxBodyBytes} bytes`,
        });
      }

      const parts = parseMultipart(body, ct);

      // Filter to matching field names.
      const filtered = parts.filter((p) => p.name === fieldname);

      // Enforce maxFiles cap.
      if (maxFiles !== undefined && filtered.length > maxFiles) {
        return ctx.response.status(400).json({
          error: 'Too many files',
          detail: `Maximum ${maxFiles} file(s) allowed`,
        });
      }

      // Validate each file.
      const uploaded: UploadedFile[] = [];
      for (const part of filtered) {
        if (part.data.length > maxSize) {
          return ctx.response.status(400).json({
            error: 'File too large',
            detail: `Maximum size is ${maxSize} bytes`,
          });
        }
        if (allowedMimeTypes && !allowedMimeTypes.includes(part.mimeType)) {
          return ctx.response.status(400).json({
            error: 'Invalid MIME type',
            detail: `Type '${part.mimeType}' not allowed`,
          });
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
      await next();
      return;
    } catch {
      // Malformed body → 400.
      return ctx.response.status(400).json({
        error: 'Malformed request',
        detail: 'Failed to parse multipart body',
      });
    }
  };
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
