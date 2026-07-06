/**
 * Route matcher — parses parameterized path patterns and matches incoming
 * paths against them, extracting typed parameters.
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

export type Segment = StaticSegment | ParamSegment;

/**
 * Parses a route pattern like `/users/:id` into segments.
 *
 * @param pattern - The route pattern
 * @returns The parsed segments
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
 * Normalizes a path by collapsing trailing slashes (except root `/`).
 *
 * @param path - The raw path
 * @returns The normalized path
 */
function normalizePath(path: string): string {
  if (path === '/') {
    return path;
  }
  return path.replace(/\/+$/, '');
}

/**
 * Matches a route pattern against an incoming path.
 *
 * @param segments - The parsed pattern segments
 * @param path - The incoming request path
 * @returns Extracted parameters on match, or `null` when the path doesn't match
 */
export function match(
  segments: readonly Segment[],
  path: string,
): Record<string, string> | null {
  const normalized = normalizePath(path);
  const parts = normalized === '/' ? [''] : normalized.slice(1).split('/');

  if (parts.length !== segments.length) {
    return null;
  }

  const params: Record<string, string> = {};
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    let decoded: string;
    try {
      decoded = decodeURIComponent(parts[i]);
    } catch {
      // Malformed percent-encoding (e.g. `%zz`) cannot equal any static
      // value or form a valid parameter, so this route simply does not
      // match. Keeping `match` total (it never throws) means a raw
      // `decodeURIComponent` failure can never escalate to a 500. The
      // application rejects such paths with a 400 BEFORE routing via
      // {@linkcode isPathDecodable}; this guard covers any direct caller.
      return null;
    }
    if (segment.type === 'static') {
      if (decoded !== segment.value) {
        return null;
      }
    } else {
      params[segment.name] = decoded;
    }
  }
  return params;
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
 */
export function isPathDecodable(path: string): boolean {
  try {
    decodeURIComponent(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Counts the number of static (non-parameter) segments in a pattern.
 *
 * @param segments - The parsed pattern segments
 * @returns The static segment count (higher = more specific match)
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
