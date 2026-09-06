/**
 * The one path-exclusion matcher.
 *
 * Four middlewares in this framework exempt operational paths from their own
 * work — the rate limiter, the tenant resolver, the request logger and the HTTP
 * metrics collector — and before this module each carried its own copy of the
 * matching loop. The copies disagreed: two matched literals only, one accepted
 * a `RegExp` but re-tested it with an O(n) `typeof` branch per request, and
 * exactly one of them reset `lastIndex` before `.test`, which is the difference
 * between a `g`-flagged pattern matching every request and matching every other
 * request.
 *
 * Living in `common` is what §2.1 permits (a pure zero-dependency utility) and
 * what §2.2 requires (no plugin may import another), following M55's promotion
 * of the content-type map and M47's of the realtime frame codec.
 *
 * @module
 */

/**
 * One exclusion entry: an exact path, or a pattern tested against the path.
 *
 * A string is compared with `===` against `IRequest.path`, never as a prefix —
 * `'/health'` does not exempt `/healthz`. Use a `RegExp` when a prefix or a
 * family of paths is meant.
 *
 * @since 0.5.0
 */
export type PathPattern = string | RegExp;

/**
 * Builds a path-exclusion predicate from a list of literals and patterns.
 *
 * The list is partitioned ONCE, at construction: literals go into a `Set` so
 * the common case stays an O(1) hash lookup on the request hot path, and the
 * patterns are kept in an array walked only when the literal lookup misses.
 * An all-literal list — which is what every default in this framework is —
 * therefore costs exactly what the hand-rolled `Set.has` copies cost, and a
 * mixed list costs one hash lookup plus one pass over the patterns rather than
 * a `typeof` branch per entry per request.
 *
 * `lastIndex` is reset before each `.test`. That is a correctness requirement,
 * not hygiene: `RegExp.prototype.test` on a `g`- or `y`-flagged pattern
 * advances `lastIndex` and resumes from it on the next call, so a shared
 * pattern would match the first request, miss the second, match the third.
 *
 * @param patterns - The exclusion entries. An empty list matches nothing.
 * @returns A predicate answering whether the path is excluded.
 * @example
 * ```typescript
 * const isExcluded = createPathMatcher(['/live', '/ready', /^\/internal\//]);
 * isExcluded('/live');           // true
 * isExcluded('/internal/debug'); // true
 * isExcluded('/orders');         // false
 * ```
 * @since 0.5.0
 */
export function createPathMatcher(
  patterns: readonly PathPattern[],
): (path: string) => boolean {
  const literals = new Set<string>();
  const expressions: RegExp[] = [];

  for (const entry of patterns) {
    if (typeof entry === 'string') {
      literals.add(entry);
    } else {
      expressions.push(entry);
    }
  }

  // The all-literal case is the overwhelmingly common one (every default list
  // in this framework), so it gets a predicate that never touches the empty
  // pattern array.
  if (expressions.length === 0) {
    if (literals.size === 0) {
      return () => false;
    }
    return (path: string): boolean => literals.has(path);
  }

  return (path: string): boolean => {
    if (literals.has(path)) {
      return true;
    }
    for (const expression of expressions) {
      // See the module note: a stateful `g`/`y` pattern otherwise matches
      // every other call.
      expression.lastIndex = 0;
      if (expression.test(path)) {
        return true;
      }
    }
    return false;
  };
}
