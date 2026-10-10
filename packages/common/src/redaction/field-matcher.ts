/** Internal compiled matcher for redaction field paths. */

import type { DataClassification } from './classification.ts';
import type { FieldRedaction } from './policy.ts';
import type { Redactor } from './redactors.ts';

/** The classification and optional pattern-specific redactor a match carries. */
export interface CompiledFieldPattern {
  /** Classification reported for the matched value. */
  readonly classification: DataClassification;
  /** Redactor declared on the matched pattern, when one was supplied. */
  readonly redactor?: Redactor;
}

interface Pattern extends CompiledFieldPattern {
  readonly segments: readonly string[];
}

/** Compiles dot-path patterns that support `*` and `**`. */
export function createFieldMatcher(
  fields: Readonly<Record<string, DataClassification | FieldRedaction>>,
  caseSensitive: boolean,
): (path: string) => CompiledFieldPattern | undefined {
  const patterns: readonly Pattern[] = Object.entries(fields).map(([path, value]) => {
    const segments = path.split('.').map((
      segment,
    ) => (caseSensitive ? segment : segment.toLowerCase()));
    if (typeof value === 'string') return { segments, classification: value };
    return value.redactor === undefined
      ? { segments, classification: value.classification }
      : { segments, classification: value.classification, redactor: value.redactor };
  });
  return (path: string): CompiledFieldPattern | undefined => {
    const segments = path.split('.').map((
      segment,
    ) => (caseSensitive ? segment : segment.toLowerCase()));
    let selected: Pattern | undefined;
    for (const pattern of patterns) {
      if (
        matches(pattern.segments, segments) &&
        (selected === undefined || isMoreSpecific(pattern, selected))
      ) {
        selected = pattern;
      }
    }
    return selected;
  };
}

/** Returns whether one matching pattern is more constrained than another. */
function isMoreSpecific(candidate: Pattern, current: Pattern): boolean {
  const candidateScore = specificity(candidate.segments);
  const currentScore = specificity(current.segments);
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

/** Tests a normalized path against a compiled wildcard pattern. */
function matches(
  pattern: readonly string[],
  path: readonly string[],
): boolean {
  const results = new Map<string, boolean>();

  function visit(patternIndex: number, pathIndex: number): boolean {
    const key = `${patternIndex}:${pathIndex}`;
    const previousResult = results.get(key);
    if (previousResult !== undefined) return previousResult;

    const result = patternIndex === pattern.length
      ? pathIndex === path.length
      : matchSegment(patternIndex, pathIndex);
    results.set(key, result);
    return result;
  }

  function matchSegment(patternIndex: number, pathIndex: number): boolean {
    const segment = pattern[patternIndex]!;
    if (segment === '**') {
      return visit(patternIndex + 1, pathIndex) ||
        (pathIndex < path.length && visit(patternIndex, pathIndex + 1));
    }
    return pathIndex < path.length && (segment === '*' || segment === path[pathIndex]) &&
      visit(patternIndex + 1, pathIndex + 1);
  }

  return visit(0, 0);
}
