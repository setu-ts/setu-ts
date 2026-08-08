/**
 * Static file handler implementation.
 *
 * @module
 */

import type { IFileSystem, RouteHandler, StatResult } from '@setu-ts/common';
import { contentTypeFor, isLexicallyContained } from '@setu-ts/common';
import { resolveCacheControl } from '../http/cache-control.ts';
import { computeETag, shouldReturn304 } from '../http/conditional.ts';
import {
  formatContentRange,
  isRangeUnsatisfiable,
  parseRange,
  shouldHonourRange,
} from '../http/range.ts';
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
 * Normalizes a URL prefix to the canonical form: starts with '/', no trailing '/'.
 *
 * @param prefix - The raw prefix from user options
 * @returns The normalized prefix
 * @since 0.1.0
 */
export function normalizePrefix(prefix: string): string {
  const stripped = prefix.replace(/^\/+/, '').replace(/\/+$/, '');
  return stripped === '' ? '/' : `/${stripped}`;
}

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

  // Normalize prefix once at handler creation time
  const normalizedPrefix = normalizePrefix(urlPrefix);

  return async (ctx) => {
    // Decode the URL path
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(ctx.request.path);
    } catch {
      return ctx.response.status(400).send(new TextEncoder().encode('Bad Request'));
    }

    // Strip the URL prefix — must match exactly, not prefix-adjacent
    // For non-root prefixes, the path must start with prefix/ (with trailing slash)
    // to avoid matching /assetstest.txt when prefix is /assets
    const prefixWithSlash = normalizedPrefix === '/' ? '/' : `${normalizedPrefix}/`;
    const relativePath = decodedPath === normalizedPrefix
      ? '/'
      : decodedPath.startsWith(prefixWithSlash)
      ? decodedPath.slice(prefixWithSlash.length)
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

    // Root-relative form of the resolved path. This — never the absolute
    // filesystem path and never a `.br`/`.gz` sidecar path — is what drives
    // Cache-Control, so a hashed asset keeps its `immutable` policy whichever
    // encoding is negotiated, and a user-supplied `cacheControl` function
    // receives the documented root-relative path rather than the server's
    // directory layout.
    const rootRelative = normalizedPath === '/' ? '' : normalizedPath;

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
                relativePath: fallback,
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
              relativePath: rootRelative === '' ? index : `${rootRelative}/${index}`,
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
      relativePath: rootRelative,
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
    /** Root-relative path of the ORIGINAL resource — drives Cache-Control. */
    relativePath: string;
    etag?: boolean | undefined;
    ranges?: boolean | undefined;
    compressed?: boolean | undefined;
    maxBufferBytes?: number | undefined;
  },
): Promise<ReturnType<RouteHandler>> {
  const {
    cacheControl,
    relativePath,
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
      const response = ctx.response.status(304).header(
        'Cache-Control',
        resolveCacheControl(relativePath, { cacheControl }),
      ).header('Vary', 'Accept-Encoding');
      if (etagValue) {
        response.header('ETag', etagValue);
      }
      if (stat.mtime) {
        response.header('Last-Modified', formatHttpDate(stat.mtime));
      }
      return response.send();
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
      // `findPrecompressedSidecar` already stat'ed it; re-statting would cost a
      // second filesystem round trip per compressed request.
      const sidecarStat = sidecar.stat;
      const sidecarEtag = etag ? computeETag(sidecarStat) : undefined;

      // Re-check conditional with sidecar ETag
      if (etag && sidecarEtag) {
        const ifNoneMatch = ctx.request.headers.get('If-None-Match') ?? undefined;
        if (ifNoneMatch === sidecarEtag || ifNoneMatch === '*') {
          const response = ctx.response
            .status(304)
            .header('Cache-Control', resolveCacheControl(relativePath, { cacheControl }))
            .header('Vary', 'Accept-Encoding');
          response.header('ETag', sidecarEtag);
          response.header('Content-Encoding', sidecar.format);
          return response.send();
        }
      }

      return serveCompressedFile(ctx, fs, sidecar.path, sidecarStat, sidecar.format, {
        cacheControl,
        // The ORIGINAL path, so a hashed asset keeps `immutable` when the
        // brotli variant is negotiated. The sidecar path (`app-a1b2c3d4.js.br`)
        // never matches the content-hash pattern.
        relativePath,
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
    relativePath,
    etag,
    ranges,
    maxBufferBytes,
  });
}

/**
 * Formats a Date as an HTTP-date string (RFC 7231).
 *
 * @param date - The date to format
 * @returns The HTTP-date string
 * @since 0.1.0
 */
export function formatHttpDate(date: Date): string {
  return date.toUTCString();
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
    /** Root-relative path of the ORIGINAL resource — drives Cache-Control. */
    relativePath: string;
    etag?: boolean | undefined;
    ranges?: boolean | undefined;
    maxBufferBytes?: number | undefined;
    contentType?: string | undefined;
  },
): Promise<ReturnType<RouteHandler>> {
  const {
    cacheControl,
    relativePath,
    etag = true,
    ranges = true,
    maxBufferBytes = 1_048_576,
    contentType,
  } = options;

  const fileContentType = contentType ?? contentTypeFor(fullPath);
  const cacheControlValue = resolveCacheControl(relativePath, { cacheControl });
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
        const isHead = ctx.request.method === 'HEAD';

        // Read the range. A HEAD response carries no body, so nothing is opened
        // for it — opening a stream and then discarding it would hold the file
        // descriptor open until GC, leaking one per HEAD request.
        let body: Uint8Array | ReadableStream<Uint8Array> | undefined;
        if (!isHead) {
          if (fs.readStream && stat.size > maxBufferBytes) {
            body = await fs.readStream(fullPath, {
              start: parsedRange.start,
              end: parsedRange.end,
            });
          } else {
            const fileBytes = await fs.readFile(fullPath);
            body = fileBytes.slice(parsedRange.start, parsedRange.end + 1);
          }
        }

        const response = ctx.response
          .status(206)
          .header('Content-Type', fileContentType)
          .header('Content-Range', formatContentRange(parsedRange, stat.size))
          .header('Content-Length', rangeLength.toString())
          .header('Accept-Ranges', 'bytes')
          .header('Cache-Control', cacheControlValue)
          .header('Vary', 'Accept-Encoding');

        if (etagValue) {
          response.header('ETag', etagValue);
        }
        if (stat.mtime) {
          response.header('Last-Modified', formatHttpDate(stat.mtime));
        }
        if (contentEncoding) {
          response.header('Content-Encoding', contentEncoding);
        }

        if (isHead || body === undefined) {
          return response.send();
        }

        if (body instanceof ReadableStream) {
          return response.stream(body);
        }
        return response.send(body);
      }

      // Range header present but unparseable (e.g. multi-range with comma)
      // or unsatisfiable (e.g. start >= size): serve full file per RFC 9110.
      if (parsedRange === null) {
        if (isRangeUnsatisfiable(rangeHeader!, stat.size)) {
          const response = ctx.response
            .status(416)
            .header('Content-Range', `bytes */${stat.size}`)
            .header('Cache-Control', cacheControlValue)
            .header('Vary', 'Accept-Encoding');
          if (etagValue) {
            response.header('ETag', etagValue);
          }
          if (stat.mtime) {
            response.header('Last-Modified', formatHttpDate(stat.mtime));
          }
          return response.send();
        }
        // Continue to full-file response below.
      }
    }
  }

  // Full file response. As on the range path above, a HEAD carries no body, so
  // nothing is opened for it — otherwise every HEAD on a file larger than
  // `maxBufferBytes` would leak the descriptor the stream holds.
  const isHead = ctx.request.method === 'HEAD';
  let body: Uint8Array | ReadableStream<Uint8Array> | undefined;
  if (!isHead) {
    if (fs.readStream && stat.size > maxBufferBytes) {
      body = await fs.readStream(fullPath);
    } else {
      body = await fs.readFile(fullPath);
    }
  }

  const response = ctx.response
    .status(200)
    .header('Content-Type', fileContentType)
    .header('Content-Length', stat.size.toString())
    .header('Accept-Ranges', 'bytes')
    .header('Cache-Control', cacheControlValue)
    .header('Vary', 'Accept-Encoding');

  if (etagValue) {
    response.header('ETag', etagValue);
  }
  if (stat.mtime) {
    response.header('Last-Modified', formatHttpDate(stat.mtime));
  }
  if (contentEncoding) {
    response.header('Content-Encoding', contentEncoding);
  }

  if (isHead || body === undefined) {
    return response.send();
  }

  if (body instanceof ReadableStream) {
    return response.stream(body);
  }
  return response.send(body);
}
