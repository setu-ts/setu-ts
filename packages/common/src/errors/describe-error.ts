/**
 * Renders a thrown value as one bounded diagnostic line.
 *
 * The rendering half of {@linkcode serializeError}: that shapes a record for a
 * structured log sink, this turns the same record into the sentence a
 * string-only sink (a broker's logger option, a connection-error line, a
 * key-set refresh report) can carry. One implementation, so a change to how a
 * failure reads reaches every consumer at once.
 *
 * @module
 */

import { maskUrlUserinfo } from '../redaction/redaction-service.ts';
import { serializeError } from './serialize-error.ts';
import type { SerializedError } from './serialize-error.ts';

/** Maximum Unicode code points emitted to a string log sink. */
const MAX_DESCRIPTION_LENGTH = 8192;

/** Makes a bounded diagnostic visibly incomplete. */
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
 * Renders a thrown value, including its safe classifier fields, cause chain,
 * and aggregate members, as a single diagnostic line.
 *
 * The line is bounded to 8192 Unicode code points; a value cut by that bound
 * ends with `… [truncated]`. Since 0.12.0 URL userinfo in every name, message
 * and classifier value is masked (`redis://***@host`) before that bound
 * applies, so a cut cannot expose part of a password. Whitespace and control or format characters are
 * normalized to a single space, so one rendered value can never inject a line
 * break into a text log sink.
 *
 * @param value - The value that was thrown or rejected
 * @returns A one-line diagnostic safe for a string log sink
 * @since 0.11.0
 */
export function describeError(value: unknown): string {
  const budget = createDescriptionBudget();
  describeSerializedError(serializeError(value), budget);
  return `${budget.segments.join('')}${budget.truncated ? TRUNCATION_MARKER : ''}`;
}

/** Creates the shared budget for error rendering. */
function createDescriptionBudget(): DescriptionBudget {
  return {
    segments: [],
    length: 0,
    pendingWhitespace: false,
    truncated: false,
  };
}

/** Appends one serialized failure while preserving the shared output budget. */
function describeSerializedError(error: SerializedError, budget: DescriptionBudget): void {
  // Each text is masked WHOLE before it enters the budget: cut first, a URL
  // whose `@` fell past the bound would no longer read as a URL and its
  // password would be printed (M131a audit).
  if (
    !append(budget, maskUrlUserinfo(error.name)) ||
    !append(budget, ': ') ||
    !append(budget, maskUrlUserinfo(error.message))
  ) {
    return;
  }

  if (error.classifiers !== undefined) {
    if (!append(budget, ' (')) return;
    let first = true;
    for (const [key, value] of Object.entries(error.classifiers)) {
      if ((!first && !append(budget, ', ')) || !append(budget, key) || !append(budget, '=')) return;
      if (!append(budget, maskUrlUserinfo(String(value)))) return;
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
