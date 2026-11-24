/**
 * The storage fault table (V13-217): every rejection shape a provider can see,
 * and the class, status and message it becomes.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';
import {
  BackendOutcomeUnknownError,
  BackendUnavailableError,
  httpStatusHintOf,
} from '@setu-ts/common';
import type { StorageOperation } from '../../src/providers/fault.ts';
import {
  answeredBelow500,
  answeredStatus,
  DEFAULT_STORAGE_REQUEST_TIMEOUT_MS,
  resolveRequestTimeout,
  runBounded,
  StorageDeadlineError,
  toStorageError,
} from '../../src/providers/fault.ts';

const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), {
  code: 'ECONNREFUSED',
});
const reset = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
const awsStatus = (status: number): Error =>
  Object.assign(new Error(`AWS ${status}`), { $metadata: { httpStatusCode: status } });
const azureStatus = (status: number): Error =>
  Object.assign(new Error(`Azure ${status}`), { statusCode: status });
const gcsStatus = (status: number): Error =>
  Object.assign(new Error(`GCS ${status}`), { code: status });

type Outcome = 503 | 504 | 'named';

/** shape, read outcome, write outcome. */
const TABLE: readonly (readonly [string, unknown, Outcome, Outcome])[] = [
  ['expired bound', new StorageDeadlineError('late'), 503, 504],
  ['connection refused', refused, 503, 503],
  ['connection reset', reset, 503, 504],
  ['AWS 502', awsStatus(502), 503, 504],
  ['GCS 502', gcsStatus(502), 503, 504],
  ['AWS 503', awsStatus(503), 503, 503],
  ['AWS 500', awsStatus(500), 503, 504],
  ['Azure 502', azureStatus(502), 503, 504],
  ['Azure 504', azureStatus(504), 503, 504],
  ['GCS 503', gcsStatus(503), 503, 503],
  ['GCS 500', gcsStatus(500), 503, 504],
  ['AWS 403', awsStatus(403), 'named', 'named'],
  ['Azure 401', azureStatus(401), 'named', 'named'],
  ['plain error', new Error('boom'), 'named', 'named'],
  ['a string', 'boom', 'named', 'named'],
];

function check(error: Error, outcome: Outcome, op: StorageOperation, cause: unknown): void {
  if (outcome === 'named') {
    expect(error.constructor).toBe(Error);
    expect(error.message.startsWith(`storage-plugin (gcs): ${op} failed: `)).toBe(true);
    expect(httpStatusHintOf(error)).toBeUndefined();
  } else {
    expect(error).toBeInstanceOf(
      outcome === 503 ? BackendUnavailableError : BackendOutcomeUnknownError,
    );
    expect(httpStatusHintOf(error)?.status).toBe(outcome);
    expect((error as BackendUnavailableError).source).toBe(`storage-plugin (gcs): ${op}`);
  }
  expect(error.cause).toBe(cause);
}

describe('toStorageError (V13-217)', () => {
  for (const [name, cause, readOutcome, writeOutcome] of TABLE) {
    it(`${name}: a read is ${readOutcome}, a write is ${writeOutcome}`, () => {
      for (const op of ['get', 'exists', 'getStream', 'getSignedUrl'] as const) {
        check(toStorageError(cause, 'gcs', op), readOutcome, op, cause);
      }
      // The write column is for a client the provider built with its SDK
      // retry off, so a rejection with no attempt count was one attempt.
      for (const op of ['put', 'delete'] as const) {
        check(toStorageError(cause, 'gcs', op, true), writeOutcome, op, cause);
      }
    });
  }

  it('a write refused by a client that may retry (no attempt count) is outcome-unknown', () => {
    for (const cause of [refused, awsStatus(503), gcsStatus(503)]) {
      for (const op of ['put', 'delete'] as const) {
        check(toStorageError(cause, 'gcs', op), 504, op, cause);
      }
    }
  });

  it('returns an already classified fault unchanged', () => {
    const fault = new BackendUnavailableError('x', { cause: refused });
    expect(toStorageError(fault, 'gcs', 'get')).toBe(fault);
    const unknown = new BackendOutcomeUnknownError('x', { cause: refused });
    expect(toStorageError(unknown, 'azure', 'put')).toBe(unknown);
  });

  it('cuts a long cause message in the named error', () => {
    const error = toStorageError(new Error('x'.repeat(1000)), 's3', 'get');
    expect(error.message.length).toBeLessThan(400);
  });
});

describe('answeredStatus / answeredBelow500', () => {
  it('reads the three SDK shapes and ignores anything else', () => {
    expect(answeredStatus(awsStatus(404))).toBe(404);
    expect(answeredStatus(azureStatus(403))).toBe(403);
    expect(answeredStatus(gcsStatus(503))).toBe(503);
    expect(answeredStatus(refused)).toBeUndefined();
    expect(answeredStatus(Object.assign(new Error('x'), { code: 42 }))).toBeUndefined();
    expect(answeredStatus(null)).toBeUndefined();
    expect(answeredStatus('x')).toBeUndefined();
    expect(answeredBelow500(azureStatus(403))).toBe(true);
    expect(answeredBelow500(azureStatus(503))).toBe(false);
    expect(answeredBelow500(refused)).toBe(false);
  });
});

describe('resolveRequestTimeout', () => {
  it('defaults to 30 s and accepts 0 (unbounded)', () => {
    expect(resolveRequestTimeout(undefined)).toBe(DEFAULT_STORAGE_REQUEST_TIMEOUT_MS);
    expect(DEFAULT_STORAGE_REQUEST_TIMEOUT_MS).toBe(30_000);
    expect(resolveRequestTimeout(0)).toBe(0);
    expect(resolveRequestTimeout(250)).toBe(250);
  });

  for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648]) {
    it(`refuses ${bad} with a RangeError naming the option`, () => {
      expect(() => resolveRequestTimeout(bad)).toThrow(RangeError);
      expect(() => resolveRequestTimeout(bad)).toThrow(/requestTimeoutMs/);
    });
  }
});

describe('runBounded', () => {
  it('rejects with a StorageDeadlineError naming provider, call and bound, and aborts', async () => {
    let seen: AbortSignal | undefined;
    const error = await runBounded({ timeoutMs: 20 }, 'azure', 'get', (signal) => {
      seen = signal;
      return new Promise<never>(() => undefined);
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StorageDeadlineError);
    expect((error as Error).message).toBe(
      'storage-plugin (azure): get did not answer within 20 ms',
    );
    expect(seen?.aborted).toBe(true);
  });

  it('passes the call result through and uses the given timer surface', async () => {
    let armed = 0;
    const value = await runBounded(
      {
        timeoutMs: 1000,
        timing: {
          setTimer: (fn, ms) => {
            armed = ms;
            return setTimeout(fn, ms);
          },
          clearTimer: (handle) => {
            clearTimeout(handle as ReturnType<typeof setTimeout>);
          },
        },
      },
      's3',
      'exists',
      () => Promise.resolve(7),
    );
    expect(value).toBe(7);
    expect(armed).toBe(1000);
  });
});

describe('a backend message cannot forge a log line', () => {
  it('control characters in the cause message are replaced', () => {
    const error = toStorageError(
      new Error('denied\r\nfake: line\u0000\u0085a\u009bb\u2028c\u2029'),
      's3',
      'get',
    );
    expect(error.message).toBe('storage-plugin (s3): get failed: denied  fake: line  a b c ');
  });
});
