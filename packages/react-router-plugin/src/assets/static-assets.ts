/**
 * Static asset handlers — serve built client assets over IFileSystem.
 *
 * Delegates to shared `@setu-ts/common` utilities for content-type resolution
 * and path containment, so both packages read one implementation.
 *
 * Two handlers share one containment reader:
 *
 * - {@linkcode createStaticAssetHandler} serves content-hashed build assets
 *   under `assetUrlPrefix` with `immutable` caching.
 * - {@linkcode createPublicFileHandler} (M70n X5-5) serves files from the
 *   client-build ROOT — where Vite copies `public/`, outside any URL prefix —
 *   with `must-revalidate` caching, because those files (`robots.txt`,
 *   `favicon.ico`) are not content-hashed and an `immutable` year would be
 *   unrecoverable from the browser's side.
 *
 * @module
 * @since 0.1.0
 */

import type { HandlerResult, IFileSystem, IRequestContext, RouteHandler } from '@setu-ts/common';
import { contentTypeFor, isLexicallyContained } from '@setu-ts/common';

/**
 * Immutable Cache-Control header value for built assets.
 *
 * @since 0.1.0
 */
const CACHE_CONTROL_IMMUTABLE = 'public, max-age=31536000, immutable';

/**
 * Cache-Control header value for client-build ROOT files. These files are NOT
 * content-hashed, so the browser must revalidate instead of trusting a cached
 * copy for a year.
 *
 * @since 0.2.0
 */
const CACHE_CONTROL_MUST_REVALIDATE = 'public, max-age=0, must-revalidate';

/**
 * Builds a reader that resolves and reads `relativePath` inside `baseDir`,
 * returning `undefined` for every refused or missing read.
 *
 * Both handlers route their reads through this ONE guard so a second root can
 * never grow a second, weaker traversal check:
 *
 * 1. Lexical: reject `..` segments in the caller-decoded relative path to
 *    block traversal from the attacker-controlled vector (the URL). Combined
 *    with prepending `baseDir`, this keeps every resolved path lexically
 *    inside the root.
 * 2. Symlink-safe containment: when the runtime can canonicalize paths
 *    (`fs.realPath`, present on the real Node/Deno/Bun adapters), resolve both
 *    the root and the target and confirm the target stays inside the root.
 *    This defeats a symlink INSIDE `baseDir` that points outside it. The root's
 *    real path is resolved once (lazily, since `realPath` is async) instead of
 *    on every request. When `realPath` is absent (edge runtimes, minimal
 *    fakes), containment degrades to the lexical guard above.
 * 3. Read failures (missing file, permission) also return `undefined`.
 *
 * @param fs - The injected filesystem seam
 * @param baseDir - The directory every read must stay inside
 * @returns A reader mapping a relative path to its bytes, or `undefined`
 * @since 0.2.0
 */
function createContainedReader(
  fs: IFileSystem,
  baseDir: string,
): (relativePath: string) => Promise<Uint8Array | undefined> {
  let baseRealPath: string | undefined;

  return async (relativePath: string): Promise<Uint8Array | undefined> => {
    if (!isLexicallyContained(relativePath)) {
      return undefined;
    }

    const fullPath = `${baseDir}/${relativePath}`;

    if (fs.realPath) {
      let realBase: string;
      let realTarget: string;
      try {
        realBase = baseRealPath ??= await fs.realPath(baseDir);
        realTarget = await fs.realPath(fullPath);
      } catch {
        // Unresolvable (missing file / broken symlink) → treat as not found.
        return undefined;
      }
      if (realTarget !== realBase && !realTarget.startsWith(`${realBase}/`)) {
        return undefined;
      }
    }

    try {
      return await fs.readFile(fullPath);
    } catch {
      return undefined;
    }
  };
}

/**
 * Creates a static-asset `RouteHandler` that serves files from a directory
 * using the injected `IFileSystem`.
 *
 * Returns `404` when `fs` is absent or the requested file is missing.
 *
 * @param options - Configuration
 * @returns A route handler function
 * @since 0.1.0
 */
export function createStaticAssetHandler(options: {
  fs: IFileSystem;
  assetsDir: string;
  assetUrlPrefix: string;
}): RouteHandler {
  const { fs, assetsDir, assetUrlPrefix } = options;
  const read = createContainedReader(fs, assetsDir);

  return async (ctx) => {
    // Decode the URL path to get the file system path.
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(ctx.request.path);
    } catch {
      return ctx.response.status(400).send(
        new TextEncoder().encode('Bad Request'),
      );
    }

    // Strip the URL prefix to get the relative file path.
    const relativePath = decodedPath.startsWith(assetUrlPrefix)
      ? decodedPath.slice(assetUrlPrefix.length)
      : decodedPath;

    if (relativePath === '' || relativePath === '/') {
      return ctx.response.status(404).send();
    }

    const bytes = await read(relativePath);
    if (bytes === undefined) {
      return ctx.response.status(404).send();
    }

    return ctx.response
      .header('Content-Type', contentTypeFor(`${assetsDir}/${relativePath}`))
      .header('Cache-Control', CACHE_CONTROL_IMMUTABLE)
      .send(bytes);
  };
}

/**
 * Creates a handler that ATTEMPTS to serve a file from the client-build ROOT
 * (where Vite copies `public/`), resolving the request path relative to
 * {@linkcode createPublicFileHandler.options.assetsDir}.
 *
 * Returns the served {@linkcode HandlerResult} on a hit — including the
 * `400` answer for an undecodable request path — and `undefined` on a miss so
 * the caller can fall through to the next handler (the SSR catch-all).
 *
 * Successful responses carry `Cache-Control: public, max-age=0,
 * must-revalidate`: root files are not content-hashed, so an `immutable` year
 * would serve stale content the browser refuses to re-check.
 *
 * @param options - Configuration
 * @returns An attempt handler resolving to a result, or `undefined` on a miss
 * @since 0.2.0
 */
export function createPublicFileHandler(options: {
  fs: IFileSystem;
  assetsDir: string;
}): (ctx: IRequestContext) => Promise<HandlerResult | undefined> {
  const read = createContainedReader(options.fs, options.assetsDir);

  return async (ctx): Promise<HandlerResult | undefined> => {
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(ctx.request.path);
    } catch {
      return ctx.response.status(400).send(
        new TextEncoder().encode('Bad Request'),
      );
    }

    // The bare root is not a file; let SSR render whatever it maps to.
    if (decodedPath === '' || decodedPath === '/') {
      return undefined;
    }

    // Strip the single leading slash so the remainder is root-relative;
    // `isLexicallyContained` rejects absolute paths outright.
    const bytes = await read(decodedPath.slice(1));
    if (bytes === undefined) {
      return undefined;
    }

    return ctx.response
      .header('Content-Type', contentTypeFor(decodedPath))
      .header('Cache-Control', CACHE_CONTROL_MUST_REVALIDATE)
      .send(bytes);
  };
}
