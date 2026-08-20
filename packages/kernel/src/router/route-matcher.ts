/**
 * Route matcher utilities — path decoding guard and pattern-parsing helpers
 * for the kernel router.
 *
 * As of Milestone 22, route *matching* is delegated to Hono inside the
 * [`Router`](./router.ts).  This module exports:
 *
 * - {@linkcode isPathDecodable} — used by the application to reject malformed
 *   percent-escapes with a 400 **before** routing.
 * - {@linkcode Segment}, {@linkcode parsePattern}, {@linkcode staticSegmentCount},
 *   {@linkcode wildcardSegmentCount} — parsing primitives shared with the Router's
 *   tie-break logic.
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

interface WildcardSegment {
  type: 'wildcard';
}

/**
 * A parsed route segment — a static path component, a `:name` parameter
 * placeholder, or the `*` wildcard.
 *
 * The wildcard arm was added in M70g. Before it, `*` parsed as a STATIC segment,
 * so `/*` scored the same specificity as `/openapi.json` and the tie was decided
 * by registration order alone — which silently removed every single-segment
 * plugin route registered after an application catch-all.
 *
 * @since 0.1.0
 */
export type Segment = StaticSegment | ParamSegment | WildcardSegment;

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
    // Exactly `*`, never a segment merely CONTAINING one: `/a*` is not a pattern
    // any first-party plugin registers, and treating it as a wildcard would lower
    // the specificity of a path that matches literally.
    if (part === '*') {
      return { type: 'wildcard' };
    }
    return { type: 'static', value: part };
  });
}

/**
 * Counts the literal path components in a pattern.
 *
 * Neither a `:param` nor a `*` wildcard counts: both match text the pattern does
 * not name, so neither makes the route more specific.
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
 * Counts the `*` wildcard segments in a pattern.
 *
 * The router's second tie-break key, read ASCENDING: between two routes with the
 * same number of literal components, the one matching less arbitrary text is the
 * more specific. That is what puts `/a/:id` ahead of `/a/*`, which before M70g
 * lost in both registration orders because `*` was counted as a literal.
 *
 * @param segments - The parsed segments array
 * @returns The count of wildcard segments
 * @internal Used only at registration time for tie-break specificity.
 */
export function wildcardSegmentCount(segments: readonly Segment[]): number {
  let count = 0;
  for (const segment of segments) {
    if (segment.type === 'wildcard') {
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
