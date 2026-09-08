/**
 * `classifyDriverError` (X38-1/X35-2, M90f) — one case per §3.2 signal-table
 * row against synthetic errors, plus the walk's contract: a cause chain, a
 * frozen error, a cyclic chain, and a thrown non-`Error`.
 *
 * The synthetic cases prove the MAPPING. The LIVE guarded suites
 * (`real-*.test.ts`) prove the drivers actually EMIT the signals — a table
 * asserted only against synthetic errors would survive a driver renaming its
 * `code`.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { classifyDriverError } from '../../src/errors/classify.ts';
import { DatabaseUnavailableError, SerializationConflictError } from '../../src/errors.ts';

describe('classifyDriverError — conflict signals (409)', () => {
  it('PostgreSQL SQLSTATE class 40 (40001 serialization_failure)', () => {
    expect(classifyDriverError({ code: '40001' })).toBe('conflict');
  });

  it('PostgreSQL SQLSTATE class 40 (40P01 deadlock_detected)', () => {
    expect(classifyDriverError({ code: '40P01' })).toBe('conflict');
  });

  it('MongoDB TransientTransactionError label', () => {
    expect(
      classifyDriverError({ name: 'MongoError', errorLabels: ['TransientTransactionError'] }),
    ).toBe('conflict');
  });

  it('DynamoDB TransactionConflictException', () => {
    expect(classifyDriverError({ name: 'TransactionConflictException' })).toBe('conflict');
  });

  it('Bigtable gRPC ABORTED (10)', () => {
    expect(classifyDriverError({ code: 10 })).toBe('conflict');
  });

  it('Cosmos DB 449 Retry With', () => {
    expect(classifyDriverError({ code: 449 })).toBe('conflict');
  });

  it('a MongoServerError with BOTH a numeric code and the label still classifies', () => {
    // Measured on a real replica set: `MongoServerError code=112
    // codeName=WriteConflict errorLabels=["TransientTransactionError"]`. An
    // unmatched numeric code must not veto the structured label signal.
    expect(
      classifyDriverError({
        name: 'MongoServerError',
        code: 112,
        codeName: 'WriteConflict',
        errorLabels: ['TransientTransactionError'],
      }),
    ).toBe('conflict');
  });
});

describe('classifyDriverError — unavailable signals (503)', () => {
  it('PostgreSQL SQLSTATE class 08', () => {
    expect(classifyDriverError({ code: '08006' })).toBe('unavailable');
  });

  it('PostgreSQL 57P03 cannot_connect_now', () => {
    expect(classifyDriverError({ code: '57P03' })).toBe('unavailable');
  });

  it('the pg pool timeout anchor, which carries no code', () => {
    expect(
      classifyDriverError(new Error('timeout exceeded when trying to connect')),
    ).toBe('unavailable');
  });

  it('MongoDB MongoNetworkError by name', () => {
    expect(classifyDriverError({ name: 'MongoNetworkError' })).toBe('unavailable');
  });

  it('MongoDB MongoServerSelectionError by name', () => {
    expect(classifyDriverError({ name: 'MongoServerSelectionError' })).toBe('unavailable');
  });

  it('the AWS SDK network-error names', () => {
    expect(classifyDriverError({ name: 'TimeoutError' })).toBe('unavailable');
    expect(classifyDriverError({ name: 'NetworkingError' })).toBe('unavailable');
  });

  it('Bigtable gRPC UNAVAILABLE (14)', () => {
    expect(classifyDriverError({ code: 14 })).toBe('unavailable');
  });

  it('Cosmos DB 429 and 503', () => {
    expect(classifyDriverError({ code: 429 })).toBe('unavailable');
    expect(classifyDriverError({ code: 503 })).toBe('unavailable');
  });
});

describe('classifyDriverError — the walk', () => {
  it('reads a TWO-DEEP cause chain — drizzle wraps the pg error one level down', () => {
    const driver = { code: '40001', message: 'could not serialize access' };
    const wrapper = new Error('Failed query: update x38.account set …', { cause: driver });
    expect(classifyDriverError(wrapper)).toBe('conflict');
  });

  it('prefers a code found DEEPER in the chain over a generic name at the top', () => {
    // A generic `TimeoutError` name at the top must not stop the walk from
    // finding the typed signal underneath.
    const top = new Error('Failed query: …', {
      cause: { code: '40001', name: 'SomethingElse' },
    });
    expect(classifyDriverError(top)).toBe('conflict');
  });

  it('a FROZEN error still classifies — the walk reads, it never brands', () => {
    const frozen = Object.freeze(
      new Error('Failed query: …', {
        cause: { code: '40001' },
      }),
    );
    expect(classifyDriverError(frozen)).toBe('conflict');
  });

  it('a cyclic cause chain terminates instead of hanging', () => {
    const a: { cause?: unknown } = { cause: undefined };
    const b: { cause?: unknown } = { cause: undefined };
    a.cause = b;
    b.cause = a; // two-node loop
    expect(classifyDriverError(a)).toBe(null);
  });

  it('a self-caused error terminates', () => {
    const self: { cause?: unknown; code?: string } = {};
    self.cause = self;
    expect(classifyDriverError(self)).toBe(null);
  });

  it('a thrown string returns null', () => {
    expect(classifyDriverError('total meltdown')).toBe(null);
    expect(classifyDriverError(42)).toBe(null);
    expect(classifyDriverError(null)).toBe(null);
    expect(classifyDriverError(undefined)).toBe(null);
  });

  it('an unrecognised error returns null — it keeps the masked 500', () => {
    expect(classifyDriverError(new Error('something unrelated'))).toBe(null);
    expect(classifyDriverError({ code: '23505' })).toBe(null); // not class 40
  });

  it('a hostile getter reads as no signal, never throws', () => {
    const hostile = {
      get code(): string {
        throw new TypeError('boom');
      },
    };
    expect(classifyDriverError(hostile)).toBe(null);
  });
});

describe('classifyDriverError — already-classified errors', () => {
  it('a package-owned SerializationConflictError returns null — pass through untouched', () => {
    const mine = new SerializationConflictError('rejected by the backend');
    expect(classifyDriverError(mine)).toBe(null);
    // Even one whose CAUSE carries a fresh signal: re-wrapping would put the
    // first wrapper into the caller's `cause` chain.
    const wrapping = new SerializationConflictError('again', { cause: { code: '40001' } });
    expect(classifyDriverError(wrapping)).toBe(null);
  });

  it('a package-owned DatabaseUnavailableError returns null too', () => {
    const mine = new DatabaseUnavailableError('pool exhausted', { cause: { code: '08006' } });
    expect(classifyDriverError(mine)).toBe(null);
  });
});
