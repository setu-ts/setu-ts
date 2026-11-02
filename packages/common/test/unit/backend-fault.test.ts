/**
 * `toBackendFault`: the classification as a data table (M131a §3.6).
 *
 * Every row is a MEASURED thrown shape (ioredis 5.11.1 / node-redis 6.3.0
 * against a stopped and a paused Redis 7), not an inference. The table covers
 * the two classes, the pass-through of an unrecognised shape, the cause
 * chain, and the already-wrapped / `PublishTimeoutError` non-rewrap.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';
import {
  BackendOutcomeUnknownError,
  BackendUnavailableError,
  httpStatusHintOf,
  toBackendFault,
} from '../../src/index.ts';

const SOURCE = 'queue-plugin: redis adapter';

/** A measured ioredis / node-redis thrown shape. */
function err(name: string, message: string, extra: Record<string, unknown> = {}): Error {
  const e = new Error(message);
  e.name = name;
  Object.assign(e, extra);
  return e;
}

/** The classification table: measured shape → expected class (or pass-through). */
type ExpectClass = (new (source: string, options: { cause: unknown }) => Error) | 'pass';
const TABLE: ReadonlyArray<readonly [label: string, shape: unknown, expectClass: ExpectClass]> = [
  // 503 — refused before sending.
  [
    'ioredis stopped: MaxRetriesPerRequestError (offline-queue rejection)',
    err(
      'MaxRetriesPerRequestError',
      'Reached the max retries per request limit (which is 1). Refer to "maxRetriesPerRequest" option for details.',
    ),
    BackendUnavailableError,
  ],
  ['node-redis stopped: first-connect ECONNREFUSED (cause code)', err('Error', 'Redis connection failed: connect ECONNREFUSED 127.0.0.1:63799', { cause: err('Error', 'connect ECONNREFUSED 127.0.0.1:63799', { code: 'ECONNREFUSED' }) }), BackendUnavailableError],
  ['node-redis: client closed', err('Error', 'The client is closed'), BackendUnavailableError],
  ['node-redis: client offline', err('Error', 'The client is offline'), BackendUnavailableError],
  ['node-redis: socket closed unexpectedly', err('Error', 'Socket closed unexpectedly'), BackendUnavailableError],
  ['node-redis: connection timeout', err('Error', 'Connection timeout'), BackendUnavailableError],
  ['ioredis: connection closed', err('Error', 'Connection is closed.'), BackendUnavailableError],
  ['ioredis: offline queue disabled', err('Error', "Stream isn't writeable and enableOfflineQueue options is false"), BackendUnavailableError],
  ['net code on the error itself', err('Error', 'connect ECONNRESET 127.0.0.1:6379', { code: 'ECONNRESET' }), BackendUnavailableError],
  // 504 — sent with no answer.
  ['ioredis / node-redis paused: command timed out', err('Error', 'Command timed out'), BackendOutcomeUnknownError],
  // Pass-through — unrecognised.
  ['a programming error', err('Error', 'Cannot read properties of undefined'), 'pass'],
  ['a Redis WRONGTYPE', err('Error', 'WRONGTYPE Operation against a key holding the wrong kind of value'), 'pass'],
  ['a plain value', 'not an error', 'pass'],
];

describe('toBackendFault (M131a §3.6)', () => {
  it('classifies every measured shape in the table', () => {
    for (const [label, shape, expectClass] of TABLE) {
      const fault = toBackendFault(shape, SOURCE);
      if (expectClass === 'pass') {
        expect(fault, `pass-through: ${label}`).toBeUndefined();
        continue;
      }
      expect(fault, `classified: ${label}`).toBeInstanceOf(expectClass);
      expect(fault?.source, `source: ${label}`).toBe(SOURCE);
      // The original is kept as cause for the log, never served.
      expect((fault as { cause: unknown }).cause, `cause: ${label}`).toBe(shape);
    }
  });

  it('brands 503 with the "not applied" detail', () => {
    const fault = toBackendFault(err('Error', 'The client is closed'), SOURCE);
    const hint = httpStatusHintOf(fault as Error);
    expect(hint?.status).toBe(503);
    expect(hint?.detail).toBe('The request was not applied.');
  });

  it('brands 504 with the "may have been applied" detail', () => {
    const fault = toBackendFault(err('Error', 'Command timed out'), SOURCE);
    const hint = httpStatusHintOf(fault as Error);
    expect(hint?.status).toBe(504);
    expect(hint?.detail).toBe('The backend did not answer; the request may have been applied.');
  });

  it('returns an already-wrapped fault unchanged (no nesting)', () => {
    const original = new BackendUnavailableError(SOURCE, { cause: err('Error', 'The client is closed') });
    expect(toBackendFault(original, 'other-source')).toBe(original);
  });

  it('does not rewrap a PublishTimeoutError (it carries its own 504 hint)', () => {
    // A structural stand-in: the messaging publish site checks `instanceof
    // PublishTimeoutError` before calling toBackendFault, so this asserts the
    // helper itself declines a non-driver shape rather than double-wrapping.
    const pte = err('PublishTimeoutError', 'publish timed out');
    expect(toBackendFault(pte, SOURCE)).toBeUndefined();
  });

  it('walks a bounded cause chain, stopping at a cycle', () => {
    const inner = err('Error', 'Command timed out');
    const outer = err('Error', 'wrapper', { cause: inner });
    expect(toBackendFault(outer, SOURCE)).toBeInstanceOf(BackendOutcomeUnknownError);
    // A self-referential cause must not loop.
    const cyclic = err('Error', 'wrapper');
    cyclic.cause = cyclic;
    expect(toBackendFault(cyclic, SOURCE)).toBeUndefined();
  });
});
