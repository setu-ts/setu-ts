/**
 * `toBackendFault`: the classification as a data table (M131a §3.6).
 *
 * Every row is a MEASURED thrown shape (ioredis 5.11.1 / node-redis 6.3.0
 * against a stopped and a paused Redis 7, and ioredis's own flush path for a
 * dropped connection), not an inference. The table covers the two classes per
 * dispatch state, the pass-through of an unrecognised shape, the cause chain,
 * and the already-wrapped / `PublishTimeoutError` non-rewrap.
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

const SOURCE = 'queue-plugin: enqueue';

/** A measured ioredis / node-redis thrown shape. */
function err(name: string, message: string, extra: Record<string, unknown> = {}): Error {
  const e = new Error(message);
  e.name = name;
  Object.assign(e, extra);
  return e;
}

/** What `toBackendFault` must answer, by dispatch state. */
type Outcome = typeof BackendUnavailableError | typeof BackendOutcomeUnknownError | 'pass';
const U = BackendUnavailableError;
const O = BackendOutcomeUnknownError;

/**
 * The classification table: measured shape → the answer with no context,
 * with the command provably unsent, and possibly sent. A
 * lost-connection shape is the only kind the dispatch state changes.
 */
const TABLE: ReadonlyArray<
  readonly [label: string, shape: unknown, unknown: Outcome, offline: Outcome, connected: Outcome]
> = [
  // Refused before sending — 503 whatever the state.
  [
    'node-redis stopped: first-connect ECONNREFUSED (cause code)',
    err('Error', 'Redis connection failed: connect ECONNREFUSED 127.0.0.1:63799', {
      cause: err('Error', 'connect ECONNREFUSED 127.0.0.1:63799', { code: 'ECONNREFUSED' }),
    }),
    U,
    U,
    U,
  ],
  ['node-redis: client closed', err('Error', 'The client is closed'), U, U, U],
  ['node-redis: client offline', err('Error', 'The client is offline'), U, U, U],
  ['node-redis: connection timeout', err('Error', 'Connection timeout'), U, U, U],
  [
    'ioredis: offline queue disabled',
    err('Error', "Stream isn't writeable and enableOfflineQueue options is false"),
    U,
    U,
    U,
  ],
  [
    'a host that does not resolve',
    err('Error', 'getaddrinfo ENOTFOUND r', { code: 'ENOTFOUND' }),
    U,
    U,
    U,
  ],
  // Lost connection — ioredis flushes sent commands with the same errors, so
  // only a command provably never written proves "not applied".
  [
    'ioredis: MaxRetriesPerRequestError',
    err(
      'MaxRetriesPerRequestError',
      'Reached the max retries per request limit (which is 1). Refer to "maxRetriesPerRequest" option for details.',
    ),
    O,
    U,
    O,
  ],
  ['ioredis: connection closed', err('Error', 'Connection is closed.'), O, U, O],
  ['node-redis: socket closed unexpectedly', err('Error', 'Socket closed unexpectedly'), O, U, O],
  ['a reset', err('Error', 'read ECONNRESET', { code: 'ECONNRESET' }), O, U, O],
  ['a broken pipe', err('Error', 'write EPIPE', { code: 'EPIPE' }), O, U, O],
  ['a socket timeout', err('Error', 'read ETIMEDOUT', { code: 'ETIMEDOUT' }), O, U, O],
  [
    'a reset as a string errno in the cause chain',
    err('Error', 'wrapped', { cause: err('Error', 'reset', { errno: 'ECONNRESET' }) }),
    O,
    U,
    O,
  ],
  // Sent with no answer — 504 whatever the state: a command queued offline can
  // be sent after a reconnect and then time out.
  ['ioredis / node-redis paused: command timed out', err('Error', 'Command timed out'), O, O, O],
  // Pass-through — unrecognised.
  [
    'a programming error',
    err('Error', 'Cannot read properties of undefined'),
    'pass',
    'pass',
    'pass',
  ],
  [
    'a Redis WRONGTYPE',
    err('Error', 'WRONGTYPE Operation against a key holding the wrong kind of value'),
    'pass',
    'pass',
    'pass',
  ],
  ['a plain value', 'not an error', 'pass', 'pass', 'pass'],
];

describe('toBackendFault (M131a §3.6)', () => {
  const contexts = [
    ['no dispatch state', undefined, 2],
    ['provably unsent', { unsent: true }, 3],
    ['possibly sent', { unsent: false }, 4],
  ] as const;
  for (const [contextLabel, context, column] of contexts) {
    it(`classifies every measured shape with ${contextLabel}`, () => {
      for (const row of TABLE) {
        const [label, shape] = row;
        const expected = row[column];
        const fault = toBackendFault(shape, SOURCE, context);
        if (expected === 'pass') {
          expect(fault, `pass-through: ${label}`).toBeUndefined();
          continue;
        }
        expect(fault, `classified: ${label}`).toBeInstanceOf(expected);
        expect(fault?.source, `source: ${label}`).toBe(SOURCE);
        // The original is kept as cause for the log, never served.
        expect((fault as { cause: unknown }).cause, `cause: ${label}`).toBe(shape);
      }
    });
  }

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
    const original = new BackendUnavailableError(SOURCE, {
      cause: err('Error', 'The client is closed'),
    });
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
