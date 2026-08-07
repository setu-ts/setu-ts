/**
 * Static file handler implementation.
 *
 * @module
 */

import type { IFileSystem, RouteHandler, StatResult } from '@setu-ts/common';
import { contentTypeFor, isLexicallyContained } from '@setu-ts/common';
import { resolveCacheControl } from '../http/cache-control.ts';
import { computeETag, shouldReturn304 } from '../http/conditional.ts';
import { formatContentRange, parseRange, shouldHonourRange } from '../http/range.ts';
import { findPrecompressedSidecar, getOriginalContentType } from '../http/precompressed.ts';

/**
 * Options for creating a static handler.
 *
 * @since 0.1.0
 */
export type StaticHandlerOptions = {
  /** The filesystem to use */
  fs: IFileSystem;
  /** The root directory to serve from */
  root: string;
  /** The URL prefix to strip (default: '/') */
  urlPrefix: string;
  /** The index file to serve for directories (default: 'index.html') */
  index: string;
  /** The fallback file to serve for missing paths */
  fallback?: string | undefined;
  /** Cache-Control configuration */
  cacheControl?: string | ((relativePath: string) => string) | undefined;
  /** Whether to generate ETags (default: true) */
  etag?: boolean | undefined;
  /** Whether to handle Range requests (default: true) */
  ranges?: boolean | undefined;
  /** Whether to negotiate precompressed sidecars (default: true) */
  compressed?: boolean | undefined;
  /** Maximum file size to read fully into memory (default: 1MB) */
  maxBufferBytes?: number | undefined;
};

/**
 * Creates a static file RouteHandler.
 *
 * @param options - Handler options
 * @returns A RouteHandler function
 * @since 0.1.0
 */
export function createStaticHandler(options: StaticHandlerOptions): RouteHandler {
  const {
    fs,
    root,
    urlPrefix,
    index,
    fallback,
    cacheControl,
    etag = true,
    ranges = true,
    compressed = true,
    maxBufferBytes = 1_048_576,
  } = options;

  return async (ctx) => {
    // Decode the URL path
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(ctx.request.path);
    } catch {
      return ctx.response.status(400).send(new TextEncoder().encode('Bad Request'));
    }

    // Strip the URL prefix
    const relativePath = decodedPath.startsWith(urlPrefix)
      ? decodedPath.slice(urlPrefix.length)
      : decodedPath;

    // Normalize the path
    const normalizedPath = relativePath === '' ? '/' : relativePath;

    // Reject path traversal
    if (!isLexicallyContained(normalizedPath)) {
      return ctx.response.status(404).send();
    }

    // Resolve the filesystem path
    const fullPath = normalizedPath === '/' ? root : `${root}/${normalizedPath}`;

    // Symlink-safe containment check (only for existing paths)
    if (fs.realPath) {
      let realBase: string;
      try {
        realBase = await fs.realPath(root);
      } catch {
        return ctx.response.status(404).send();
      }
      try {
        const realTarget = await fs.realPath(fullPath);
        if (realTarget !== realBase && !realTarget.startsWith(`${realBase}/`)) {
          return ctx.response.status(404).send();
        }
      } catch {
        // Path doesn't exist yet — fall through to stat/fallback
      }
    }

    // Stat the file
    let stat: StatResult;
    try {
      stat = await fs.stat(fullPath);
    } catch {
      // File doesn't exist - check fallback
      if (fallback && (ctx.request.method === 'GET' || ctx.request.method === 'HEAD')) {
        const accept = ctx.request.headers.get('Accept') ?? '';
        if (accept.includes('text/html')) {
          const fallbackPath = `${root}/${fallback}`;
          try {
            const fallbackStat = await fs.stat(fallbackPath);
            if (fallbackStat.isFile) {
              return serveFile(ctx, fs, fallbackPath, fallbackStat, {
                cacheControl,
                etag,
                ranges,
                maxBufferBytes,
              });
            }
          } catch {
            // Fallback doesn't exist
          }
        }
      }
      return ctx.response.status(404).send();
    }

    // Directory handling
    if (stat.isDirectory) {
      if (index) {
        const indexPath = `${fullPath}/${index}`;
        try {
          const indexStat = await fs.stat(indexPath);
          if (indexStat.isFile) {
            return serveFile(ctx, fs, indexPath, indexStat, {
              cacheControl,
              etag,
              ranges,
              maxBufferBytes,
            });
          }
        } catch {
          // Index doesn't exist
        }
      }
      return ctx.response.status(404).send();
    }

    // Serve the file
    return serveFile(ctx, fs, fullPath, stat, {
      cacheControl,
      etag,
      ranges,
      maxBufferBytes,
      compressed,
    });
  };
}

/**
 * Serves a file with all HTTP features (ETag, Range, compression).
 *
 * @param ctx - The request context
 * @param fs - The filesystem
 * @param fullPath - The full filesystem path
 * @param stat - The file stat result
 * @param options - Serving options
 * @returns The response
 * @since 0.1.0
 */
async function serveFile(
  ctx: Parameters<RouteHandler>[0],
  fs: IFileSystem,
  fullPath: string,
  stat: StatResult,
  options: {
    cacheControl?: string | ((relativePath: string) => string) | undefined;
    etag?: boolean | undefined;
    ranges?: boolean | undefined;
    compressed?: boolean | undefined;
    maxBufferBytes?: number | undefined;
  },
): Promise<ReturnType<RouteHandler>> {
  const {
    cacheControl,
    etag = true,
    ranges = true,
    compressed = true,
    maxBufferBytes = 1_048_576,
  } = options;

  // Compute ETag
  const etagValue = etag ? computeETag(stat) : undefined;

  // Check conditional request
  if (etag && etagValue) {
    const ifNoneMatch = ctx.request.headers.get('If-None-Match') ?? undefined;
    const ifModifiedSince = ctx.request.headers.get('If-Modified-Since') ?? undefined;

    if (shouldReturn304({ etag: true, stat, ifNoneMatch, ifModifiedSince })) {
      return ctx.response
        .status(304)
        .header('ETag', etagValue)
        .header('Cache-Control', resolveCacheControl(fullPath, { cacheControl }))
        .send();
    }
  }

  // Check precompressed sidecar
  if (compressed) {
    const acceptEncoding = ctx.request.headers.get('Accept-Encoding') ?? undefined;
    const sidecar = await findPrecompressedSidecar({
      fs,
      originalPath: fullPath,
      originalStat: stat,
      acceptEncoding,
    });

    if (sidecar) {
      const sidecarStat = await fs.stat(sidecar.path);
      const sidecarEtag = etag ? computeETag(sidecarStat) : undefined;

      // Re-check conditional with sidecar ETag
      if (etag && sidecarEtag) {
        const ifNoneMatch = ctx.request.headers.get('If-None-Match') ?? undefined;
        if (ifNoneMatch === sidecarEtag || ifNoneMatch === '*') {
          return ctx.response
            .status(304)
            .header('ETag', sidecarEtag)
            .header('Content-Encoding', sidecar.format)
            .header('Vary', 'Accept-Encoding')
            .header('Cache-Control', resolveCacheControl(fullPath, { cacheControl }))
            .send();
        }
      }

      return serveCompressedFile(ctx, fs, sidecar.path, sidecarStat, sidecar.format, {
        cacheControl,
        etag,
        ranges,
        maxBufferBytes,
        contentType: getOriginalContentType(fullPath),
      });
    }
  }

  // Normal file serving
  return serveCompressedFile(ctx, fs, fullPath, stat, undefined, {
    cacheControl,
    etag,
    ranges,
    maxBufferBytes,
  });
}

/**
 * Serves a file (possibly compressed) with Range support.
 *
 * @param ctx - The request context
 * @param fs - The filesystem
 * @param fullPath - The full filesystem path
 * @param stat - The file stat result
 * @param contentEncoding - The Content-Encoding header value
 * @param options - Serving options
 * @returns The response
 * @since 0.1.0
 */
async function serveCompressedFile(
  ctx: Parameters<RouteHandler>[0],
  fs: IFileSystem,
  fullPath: string,
  stat: StatResult,
  contentEncoding: string | undefined,
  options: {
    cacheControl?: string | ((relativePath: string) => string) | undefined;
    etag?: boolean | undefined;
    ranges?: boolean | undefined;
    maxBufferBytes?: number | undefined;
    contentType?: string | undefined;
  },
): Promise<ReturnType<RouteHandler>> {
  const { cacheControl, etag = true, ranges = true, maxBufferBytes = 1_048_576, contentType } =
    options;

  const fileContentType = contentType ?? contentTypeFor(fullPath);
  const cacheControlValue = resolveCacheControl(fullPath, { cacheControl });
  const etagValue = etag ? computeETag(stat) : undefined;

  // Check Range request
  if (ranges) {
    const rangeHeader = ctx.request.headers.get('Range') ?? undefined;
    const ifRange = ctx.request.headers.get('If-Range') ?? undefined;

    if (
      rangeHeader && shouldHonourRange({ size: stat.size, rangeHeader, ifRange, etag: etagValue })
    ) {
      const parsedRange = parseRange(rangeHeader, stat.size);
      if (parsedRange) {
        const rangeLength = parsedRange.end - parsedRange.start + 1;

        // Read the range
        let body: Uint8Array | ReadableStream<Uint8Array>;
        if (fs.readStream && stat.size > maxBufferBytes) {
          const stream = await fs.readStream(fullPath, {
            start: parsedRange.start,
            end: parsedRange.end,
          });
          body = stream;
        } else {
          const fileBytes = await fs.readFile(fullPath);
          body = fileBytes.slice(parsedRange.start, parsedRange.end + 1);
        }

        const response = ctx.response
          .status(206)
          .header('Content-Type', fileContentType)
          .header('Content-Range', formatContentRange(parsedRange, stat.size))
          .header('Content-Length', rangeLength.toString())
          .header('Accept-Ranges', 'bytes')
          .header('Cache-Control', cacheControlValue);

        if (etagValue) {
          response.header('ETag', etagValue);
        }
        if (stat.mtime) {
          response.header('Last-Modified', stat.mtime.toUTCString());
        }
        if (contentEncoding) {
          response.header('Content-Encoding', contentEncoding);
          response.header('Vary', 'Accept-Encoding');
        }

        if (ctx.request.method === 'HEAD') {
          return response.send();
        }

        if (body instanceof ReadableStream) {
          return response.stream(body);
        }
        return response.send(body);
      }
    }
  }

  // Full file response
  let body: Uint8Array | ReadableStream<Uint8Array>;
  if (fs.readStream && stat.size > maxBufferBytes) {
    const stream = await fs.readStream(fullPath);
    body = stream;
  } else {
    body = await fs.readFile(fullPath);
  }

  const response = ctx.response
    .status(200)
    .header('Content-Type', fileContentType)
    .header('Content-Length', stat.size.toString())
    .header('Accept-Ranges', 'bytes')
    .header('Cache-Control', cacheControlValue);

  if (etagValue) {
    response.header('ETag', etagValue);
  }
  if (stat.mtime) {
    response.header('Last-Modified', stat.mtime.toUTCString());
  }
  if (contentEncoding) {
    response.header('Content-Encoding', contentEncoding);
    response.header('Vary', 'Accept-Encoding');
  }

  if (ctx.request.method === 'HEAD') {
    return response.send();
  }

  if (body instanceof ReadableStream) {
    return response.stream(body);
  }
  return response.send(body);
}
