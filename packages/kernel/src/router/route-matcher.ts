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

type Segment = StaticSegment | ParamSegment;

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
    if (segment.type === 'static') {
      if (decodeURIComponent(parts[i]) !== segment.value) {
        return null;
      }
    } else {
      params[segment.name] = decodeURIComponent(parts[i]);
    }
  }
  return params;
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
