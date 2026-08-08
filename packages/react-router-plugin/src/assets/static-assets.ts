/**
 * Static asset handler — serves built client assets over IFileSystem.
 *
 * Delegates to shared `@setu-ts/common` utilities for content-type resolution
 * and path containment, so both packages read one implementation.
 *
 * @module
 * @since 0.1.0
 */

import type { IFileSystem, RouteHandler } from '@setu-ts/common';
import { contentTypeFor, isLexicallyContained } from '@setu-ts/common';

/**
 * Immutable Cache-Control header value for built assets.
 *
 * @since 0.1.0
 */
const CACHE_CONTROL_IMMUTABLE = 'public, max-age=31536000, immutable';

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

  // The canonical assets root is invariant for the handler's lifetime; resolve
  // it once (lazily, since `realPath` is async) instead of on every request.
  let assetsRealPath: string | undefined;

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

    // Reject `..` segments in the decoded request path to block traversal from
    // the attacker-controlled vector (the URL). Combined with prepending
    // `assetsDir` below, this keeps every resolved path lexically inside the
    // assets root.
    if (!isLexicallyContained(relativePath)) {
      return ctx.response.status(404).send();
    }

    const fullPath = `${assetsDir}/${relativePath}`;

    // Symlink-safe containment: when the runtime can canonicalize paths
    // (`fs.realPath`, present on the real Node/Deno/Bun adapters), resolve both
    // the assets root and the target and confirm the target stays inside the
    // root. This defeats a symlink INSIDE `assetsDir` that points outside it.
    // When `realPath` is absent (edge runtimes, minimal fakes), containment
    // degrades to the lexical `..` guard above.
    if (fs.realPath) {
      let realBase: string;
      let realTarget: string;
      try {
        realBase = assetsRealPath ??= await fs.realPath(assetsDir);
        realTarget = await fs.realPath(fullPath);
      } catch {
        // Unresolvable (missing file / broken symlink) → treat as not found.
        return ctx.response.status(404).send();
      }
      if (realTarget !== realBase && !realTarget.startsWith(`${realBase}/`)) {
        return ctx.response.status(404).send();
      }
    }

    // Determine content type from extension.
    const contentType = contentTypeFor(fullPath);

    // Read the file.
    let bytes: Uint8Array;
    try {
      bytes = await fs.readFile(fullPath);
    } catch {
      return ctx.response.status(404).send();
    }

    return ctx.response
      .header('Content-Type', contentType)
      .header('Cache-Control', CACHE_CONTROL_IMMUTABLE)
      .send(bytes);
  };
}
