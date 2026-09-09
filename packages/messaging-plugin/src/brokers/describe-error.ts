/**
 * Renders failures for broker logger options, whose error sink accepts text.
 *
 * @module
 */

import { type SerializedError, serializeError } from '@setu-ts/common';

/**
 * Renders a thrown value, including its safe classifier fields, cause chain,
 * and aggregate members, as a single diagnostic line.
 *
 * @param value - The value the broker caught
 * @returns A one-line diagnostic safe for the broker's string logger sink
 */
export function describeError(value: unknown): string {
  return describeSerializedError(serializeError(value));
}

function describeSerializedError(error: SerializedError): string {
  const classifiers = error.classifiers === undefined
    ? ''
    : ` (${Object.entries(error.classifiers).map(([key, value]) => `${key}=${value}`).join(', ')})`;
  const members = error.errors === undefined || error.errors.length === 0
    ? ''
    : ` [${error.errors.map(describeSerializedError).join('; ')}]`;
  const omitted = error.omittedErrorCount === undefined
    ? ''
    : ` [${error.omittedErrorCount} aggregate error(s) omitted]`;
  const cause = error.cause === undefined ? '' : ` <- ${describeSerializedError(error.cause)}`;
  return oneLine(`${error.name}: ${error.message}${classifiers}${members}${omitted}${cause}`);
}

function oneLine(value: string): string {
  return value.replaceAll(/\s+/g, ' ').trim();
}
