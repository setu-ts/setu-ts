/** Internal compiled matcher for redaction field paths. */

import type { DataClassification } from './classification.ts';

interface Pattern {
  readonly segments: readonly string[];
  readonly classification: DataClassification;
}

/** Compiles dot-path patterns that support `*` and `**`. */
export function createFieldMatcher(
  fields: Readonly<Record<string, DataClassification>>,
  caseSensitive: boolean,
): (path: string) => DataClassification | undefined {
  const patterns: readonly Pattern[] = Object.entries(fields).map(([path, classification]) => ({
    segments: path.split('.').map((segment) => (caseSensitive ? segment : segment.toLowerCase())),
    classification,
  }));
  return (path: string): DataClassification | undefined => {
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
    return selected?.classification;
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
  patternIndex = 0,
  pathIndex = 0,
): boolean {
  if (patternIndex === pattern.length) return pathIndex === path.length;
  const segment = pattern[patternIndex]!;
  if (segment === '**') {
    return matches(pattern, path, patternIndex + 1, pathIndex) ||
      (pathIndex < path.length && matches(pattern, path, patternIndex, pathIndex + 1));
  }
  return pathIndex < path.length && (segment === '*' || segment === path[pathIndex]) &&
    matches(pattern, path, patternIndex + 1, pathIndex + 1);
}
