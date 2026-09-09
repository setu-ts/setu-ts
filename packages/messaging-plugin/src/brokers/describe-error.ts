/**
 * Renders failures for broker logger options, whose error sink accepts text.
 *
 * @module
 */

import { serializeError } from '@setu-ts/common';
import type { SerializedError } from '@setu-ts/common';

/** Maximum Unicode code points emitted to a broker's string logger sink. */
const MAX_DESCRIPTION_LENGTH = 8192;

/** Makes a bounded broker diagnostic visibly incomplete. */
const TRUNCATION_MARKER = '… [truncated]';

/** Reserves room for the marker inside the total description limit. */
const MAX_DESCRIPTION_CONTENT_LENGTH = MAX_DESCRIPTION_LENGTH - TRUNCATION_MARKER.length;

interface DescriptionBudget {
  readonly segments: string[];
  length: number;
  pendingWhitespace: boolean;
  truncated: boolean;
}

/**
 * Renders a thrown value, including its safe classifier fields, cause chain,
 * and aggregate members, as a single diagnostic line.
 *
 * @param value - The value the broker caught
 * @returns A one-line diagnostic safe for the broker's string logger sink
 */
export function describeError(value: unknown): string {
  const budget: DescriptionBudget = {
    segments: [],
    length: 0,
    pendingWhitespace: false,
    truncated: false,
  };
  describeSerializedError(serializeError(value), budget);
  return `${budget.segments.join('')}${budget.truncated ? TRUNCATION_MARKER : ''}`;
}

/** Appends one serialized failure while preserving the shared output budget. */
function describeSerializedError(error: SerializedError, budget: DescriptionBudget): void {
  if (!append(budget, error.name) || !append(budget, ': ') || !append(budget, error.message)) {
    return;
  }

  if (error.classifiers !== undefined) {
    if (!append(budget, ' (')) return;
    let first = true;
    for (const [key, value] of Object.entries(error.classifiers)) {
      if ((!first && !append(budget, ', ')) || !append(budget, key) || !append(budget, '=')) return;
      if (!append(budget, String(value))) return;
      first = false;
    }
    if (!append(budget, ')')) return;
  }

  if (error.errors !== undefined && error.errors.length > 0) {
    if (!append(budget, ' [')) return;
    for (let index = 0; index < error.errors.length; index++) {
      if (index > 0 && !append(budget, '; ')) return;
      describeSerializedError(error.errors[index], budget);
      if (budget.truncated) return;
    }
    if (!append(budget, ']')) return;
  }

  if (error.omittedErrorCount !== undefined) {
    if (!append(budget, ` [${error.omittedErrorCount} aggregate error(s) omitted]`)) return;
  }

  if (error.cause !== undefined) {
    if (!append(budget, ' <- ')) return;
    describeSerializedError(error.cause, budget);
  }
}

/** Appends normalized text until the total description budget is spent. */
function append(budget: DescriptionBudget, value: string): boolean {
  for (const character of value) {
    if (/\s/u.test(character)) {
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
