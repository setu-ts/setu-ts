/**
 * Renders failures for broker logger options, whose error sink accepts text.
 *
 * `describeError` lives in `@setu-ts/common` so every package renders a thrown
 * value the same way; it is re-exported here for this package's own callers.
 * `describeLogText` bounds an application-supplied line to the same budget.
 *
 * @module
 */

export { describeError } from '@setu-ts/common';

/** Maximum Unicode code points emitted to a broker's string logger sink. */
const MAX_DESCRIPTION_LENGTH = 8192;

/** Makes a bounded broker diagnostic visibly incomplete. */
const TRUNCATION_MARKER = '… [truncated]';

/** Reserves room for the marker inside the total description limit. */
const MAX_DESCRIPTION_CONTENT_LENGTH = MAX_DESCRIPTION_LENGTH - TRUNCATION_MARKER.length;

/** Matches whitespace and characters that must not reach a text log sink. */
const NON_PRINTING = /[\s\p{Cc}\p{Cf}]/u;

interface DescriptionBudget {
  readonly segments: string[];
  length: number;
  pendingWhitespace: boolean;
  truncated: boolean;
}

/**
 * Normalizes and bounds a complete diagnostic for a broker's string log sink.
 *
 * @param value - Diagnostic text, including application-supplied names
 * @returns A single bounded line with control and format characters removed
 */
export function describeLogText(value: string): string {
  const budget = createDescriptionBudget();
  append(budget, value);
  return `${budget.segments.join('')}${budget.truncated ? TRUNCATION_MARKER : ''}`;
}

/** Creates the shared budget for complete diagnostics. */
function createDescriptionBudget(): DescriptionBudget {
  return {
    segments: [],
    length: 0,
    pendingWhitespace: false,
    truncated: false,
  };
}

/** Appends normalized text until the total description budget is spent. */
function append(budget: DescriptionBudget, value: string): boolean {
  for (const character of value) {
    if (NON_PRINTING.test(character)) {
      if (budget.segments.length > 0) budget.pendingWhitespace = true;
      continue;
    }
    if (budget.pendingWhitespace) {
      if (!appendCharacter(budget, ' ')) return false;
      budget.pendingWhitespace = false;
    }
    if (!appendCharacter(budget, character)) return false;
  }
  return true;
}

/** Appends one normalized code point, preserving space for a truncation marker. */
function appendCharacter(budget: DescriptionBudget, character: string): boolean {
  if (budget.length === MAX_DESCRIPTION_CONTENT_LENGTH) {
    budget.truncated = true;
    return false;
  }
  budget.segments.push(character);
  budget.length++;
  return true;
}
