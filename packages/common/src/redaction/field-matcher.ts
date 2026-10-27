/** Internal compiled matcher for redaction field paths. */

import type { DataClassification } from './classification.ts';
import type { FieldRedaction } from './policy.ts';
import { createPathCache } from './path-cache.ts';
import { eraseRedactor, type Redactor } from './redactors.ts';

/** The classification and optional pattern-specific redactor a match carries. */
export interface CompiledFieldPattern {
  /** Classification reported for the matched value. */
  readonly classification: DataClassification;
  /** Redactor declared on the matched pattern, when one was supplied. */
  readonly redactor?: Redactor;
}

interface Pattern extends CompiledFieldPattern {
  readonly segments: readonly string[];
  readonly score: readonly number[];
  readonly kind: 'literal' | 'suffix' | 'general';
  readonly memoize: boolean;
}

const PATH_CACHE_LIMIT = 1_024;
// Bounds retained memory, not just entries: field names can come from request
// bodies, and 1,024 megabyte-sized names would otherwise stay pinned.
const PATH_CACHE_MAX_KEY_LENGTH = 256;

/** Compiles dot-path patterns that support `*` and `**`. */
export function createFieldMatcher(
  fields: Readonly<Record<string, DataClassification | FieldRedaction>>,
  caseSensitive: boolean,
): (path: string) => CompiledFieldPattern | undefined {
  const patterns: readonly Pattern[] = Object.entries(fields).map(([path, value]) => {
    const segments = path
      .split('.')
      .map((segment) => (caseSensitive ? segment : segment.toLowerCase()));
    const score = specificity(segments);
    const compiled = {
      segments,
      score,
      kind:
        score[1] === 0 && score[2] === 0
          ? ('literal' as const)
          : segments.length === 2 &&
              segments[0] === '**' &&
              segments[1] !== '*' &&
              segments[1] !== '**'
            ? ('suffix' as const)
            : ('general' as const),
      memoize: score[2]! <= -2,
    };
    if (typeof value === 'string') return { ...compiled, classification: value };
    // Own properties only: an inherited `redactor` (from a polluted
    // `Object.prototype` or an entry built with `Object.create`) must never
    // replace a redactor the policy did not declare.
    // An entry without its own string `classification` (reachable only from an
    // untyped caller) is erased outright. Handing `undefined` to the class
    // lookup would read `redactors['undefined']`, a key a policy may define.
    if (!Object.hasOwn(value, 'classification') || typeof value.classification !== 'string') {
      return { ...compiled, classification: '', redactor: eraseRedactor };
    }
    const classification = value.classification;
    return Object.hasOwn(value, 'redactor') && value.redactor !== undefined
      ? { ...compiled, classification, redactor: value.redactor }
      : { ...compiled, classification };
  });
  const cache = createPathCache<Pattern | undefined>(PATH_CACHE_LIMIT, PATH_CACHE_MAX_KEY_LENGTH);
  return (path: string): CompiledFieldPattern | undefined => {
    if (cache.has(path)) return cache.get(path);
    const segments = path
      .split('.')
      .map((segment) => (caseSensitive ? segment : segment.toLowerCase()));
    let selected: Pattern | undefined;
    for (const pattern of patterns) {
      if (
        matchesCompiled(pattern, segments) &&
        (selected === undefined || isMoreSpecific(pattern, selected))
      ) {
        selected = pattern;
      }
    }
    cache.set(path, selected);
    return selected;
  };
}

/** Returns whether one matching pattern is more constrained than another. */
function isMoreSpecific(candidate: Pattern, current: Pattern): boolean {
  const candidateScore = candidate.score;
  const currentScore = current.score;
  for (let index = 0; index < candidateScore.length; index++) {
    const difference = candidateScore[index]! - currentScore[index]!;
    if (difference !== 0) return difference > 0;
  }
  // Equal patterns retain their declaration order for backwards compatibility.
  return false;
}

/** Scores literals over `*`, and `*` over the unbounded `**` wildcard. */
function specificity(segments: readonly string[]): readonly number[] {
  let literalCount = 0;
  let wildcardCount = 0;
  let globstarCount = 0;
  for (const segment of segments) {
    if (segment === '**') globstarCount++;
    else if (segment === '*') wildcardCount++;
    else literalCount++;
  }
  return [literalCount, wildcardCount, -globstarCount, segments.length];
}

/** Common shapes need only segment comparisons, with no recursive matcher state. */
function matchesCompiled(pattern: Pattern, path: readonly string[]): boolean {
  if (pattern.kind === 'suffix') return pattern.segments[1] === path[path.length - 1];
  if (pattern.kind === 'literal') {
    if (pattern.segments.length !== path.length) return false;
    for (let index = 0; index < path.length; index++) {
      if (pattern.segments[index] !== path[index]) return false;
    }
    return true;
  }
  return matches(pattern.segments, path, pattern.memoize);
}

/** Multiple globstars can revisit states; simpler patterns need no memo allocation. */
function matches(pattern: readonly string[], path: readonly string[], memoize: boolean): boolean {
  const results = memoize ? new Map<number, boolean>() : undefined;

  function visit(patternIndex: number, pathIndex: number): boolean {
    const key = patternIndex * (path.length + 1) + pathIndex;
    const previousResult = results?.get(key);
    if (previousResult !== undefined) return previousResult;

    const result =
      patternIndex === pattern.length
        ? pathIndex === path.length
        : matchSegment(patternIndex, pathIndex);
    results?.set(key, result);
    return result;
  }

  function matchSegment(patternIndex: number, pathIndex: number): boolean {
    const segment = pattern[patternIndex]!;
    if (segment === '**') {
      return (
        visit(patternIndex + 1, pathIndex) ||
        (pathIndex < path.length && visit(patternIndex, pathIndex + 1))
      );
    }
    return (
      pathIndex < path.length &&
      (segment === '*' || segment === path[pathIndex]) &&
      visit(patternIndex + 1, pathIndex + 1)
    );
  }

  return visit(0, 0);
}
