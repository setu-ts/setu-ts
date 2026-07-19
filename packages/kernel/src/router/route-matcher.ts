/**
 * Route matcher utilities — path decoding guard and pattern-parsing helpers
 * for the kernel router.
 *
 * As of Milestone 22, route *matching* is delegated to Hono inside the
 * [`Router`](./router.ts).  This module exports:
 *
 * - {@linkcode isPathDecodable} — used by the application to reject malformed
 *   percent-escapes with a 400 **before** routing.
 * - {@linkcode Segment}, {@linkcode parsePattern}, {@linkcode staticSegmentCount}
 *   — parsing primitives shared with the Router's tie-break logic.
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
 * Parses a route pattern like `/users/:id` into segments.
 *
 * @param pattern - The route pattern to parse
 * @returns An array of `Segment` objects
 * @internal Used only at registration time for tie-break statics counting.
 */
export function parsePattern(pattern: string): readonly Segment[] {
  const normalized = pattern === '/' ? '/' : pattern.replace(/\/+$/, '');
  if (normalized === '/') {
    return [{ type: 'static', value: '' }];
  }
  return normalized.slice(1).split('/').map((part) => {
    if (part.startsWith(':')) {
      return { type: 'param', name: part.slice(1) };
    }
    return { type: 'static', value: part };
  });
}

/**
 * Counts the number of static (non-parameter) segments in a pattern.
 *
 * @param segments - The parsed segments array
 * @returns The count of static segments
 * @internal Used only at registration time for tie-break specificity.
 */
export function staticSegmentCount(segments: readonly Segment[]): number {
  let count = 0;
  for (const segment of segments) {
    if (segment.type === 'static') {
      count++;
    }
  }
  return count;
}

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
