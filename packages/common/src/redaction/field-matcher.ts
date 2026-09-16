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
    return patterns.find((pattern) => matches(pattern.segments, segments))?.classification;
  };
}

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
