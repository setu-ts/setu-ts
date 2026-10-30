/**
 * The named refusal for repository input a backend rejected. Internal: not
 * exported from `src/index.ts`.
 *
 * @module
 */
import { InvalidFieldValueError, UnknownPayloadFieldError } from '@setu-ts/common';
import { prismaRefusalCause, refusedInputOf } from './classify.ts';
import { scrubDriverError } from './scrub.ts';

/**
 * Map a backend's refusal of caller input to `UnknownPayloadFieldError` or
 * `InvalidFieldValueError`, or `undefined` when the error is not one. The cause
 * is value-free: Prisma's message renders the whole query, so its cause is a
 * fresh name-and-code stand-in; any other driver error is scrubbed. One
 * implementation for the service classifier and for a direct conditional
 * write on a Prisma data source, so neither path can leak the rendered query.
 *
 * @param error - The thrown driver rejection
 * @param entity - The addressed entity
 * @returns The named refusal, or `undefined`
 */
export function refusalErrorOf(error: unknown, entity: string): Error | undefined {
  const refusal = refusedInputOf(error);
  if (refusal === null) return undefined;
  const options = { cause: prismaRefusalCause(error) ?? scrubDriverError(error) };
  return refusal.kind === 'unknown-field'
    ? new UnknownPayloadFieldError(entity, refusal.field, options)
    : new InvalidFieldValueError(entity, options);
}
