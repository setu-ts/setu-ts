/**
 * Route matcher utilities — path decoding guard for the kernel router.
 *
 * As of Milestone 22, route matching is delegated to Hono inside the
 * [`Router`](./router.ts).  This module retains only
 * {@linkcode isPathDecodable}, which is used by
 * [`Application.#handleRequest`](../application/application.ts) to reject
 * malformed percent-escapes with a 400 **before** routing.
 *
 * > **Note:** `parsePattern` and `staticSegmentCount` were moved to
 * > [`router.ts`](./router.ts) during the M22 migration so the Hono-backed
 * > tie-break logic can reuse them without a circular dependency.
 *
 * @module
 */

interface StaticSegment {
  type: 'static';
  value: string;
}

interface ParamSegment {
  type: 'param';
  name: string;
}

/**
 * A parsed route segment — either a static path component or a `:name`
 * parameter placeholder.
 *
 * @since 0.1.0
 */
export type Segment = StaticSegment | ParamSegment;

/**
 * Reports whether a path can be percent-decoded without error.
 *
 * A malformed percent-escape (e.g. `%zz`, a truncated `%2`, or a bare `%`)
 * makes {@linkcode decodeURIComponent} throw. The application uses this to
 * reject a malformed request path as a `400` before it reaches routing,
 * where an unguarded decode would otherwise surface as a `500`.
 *
 * @param path - The raw (still percent-encoded) request path
 * @returns `true` when the path decodes cleanly, `false` when it is malformed
 * @since 0.1.0
 */
export function isPathDecodable(path: string): boolean {
  try {
    decodeURIComponent(path);
    return true;
  } catch {
    return false;
  }
}
