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
import { DuplicateKeyError } from '@setu-ts/common';
import type { DatabaseAdapterType } from '../../src/interfaces/index.ts';

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
    expect(classifyDriverError({ code: 10 }, 'bigtable')).toBe('conflict');
  });

  it('Cosmos DB 449 Retry With', () => {
    expect(classifyDriverError({ code: 449 }, 'cosmos')).toBe('conflict');
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
    expect(classifyDriverError({ code: 14 }, 'bigtable')).toBe('unavailable');
  });

  it('Cosmos DB 429 and 503', () => {
    expect(classifyDriverError({ code: 429 }, 'cosmos')).toBe('unavailable');
    expect(classifyDriverError({ code: 503 }, 'cosmos')).toBe('unavailable');
  });
});

/**
 * Every duplicate-key signal, as data. Each row's error is shaped like the
 * driver's real rejection, measured against the real engine (the guarded
 * live suites prove the drivers still emit them).
 */
const DUPLICATE_SIGNALS: ReadonlyArray<{
  readonly backend: string;
  readonly error: unknown;
  readonly adapterType?: DatabaseAdapterType;
}> = [
  {
    backend: "PostgreSQL SQLSTATE 23505, under drizzle's wrapper",
    error: Object.assign(new Error('Failed query: insert into "accounts" …'), {
      cause: Object.assign(new Error('duplicate key value violates unique constraint'), {
        code: '23505',
      }),
    }),
    adapterType: 'drizzle',
  },
  {
    backend: 'Prisma P2002',
    error: Object.assign(new Error('Unique constraint failed on the constraint'), {
      name: 'PrismaClientKnownRequestError',
      code: 'P2002',
    }),
    adapterType: 'prisma',
  },
  {
    backend: 'MySQL ER_DUP_ENTRY',
    error: Object.assign(new Error("Duplicate entry 'x' for key 'accounts.email'"), {
      code: 'ER_DUP_ENTRY',
      errno: 1062,
    }),
    adapterType: 'drizzle',
  },
  {
    backend: 'MongoDB 11000',
    error: Object.assign(new Error('E11000 duplicate key error collection'), {
      name: 'MongoServerError',
      code: 11000,
    }),
    adapterType: 'mongodb',
  },
  {
    backend: 'Cosmos DB 409',
    error: Object.assign(new Error('The document already exists in the collection.'), {
      code: 409,
    }),
    adapterType: 'cosmos',
  },
  {
    backend: 'Cloudflare D1, which carries no code (measured on workerd)',
    error: new Error(
      'D1_ERROR: UNIQUE constraint failed: a.id: SQLITE_CONSTRAINT ' +
        '(extended: SQLITE_CONSTRAINT_PRIMARYKEY)',
    ),
    adapterType: 'custom',
  },
  {
    backend: 'node:sqlite',
    error: Object.assign(new Error('UNIQUE constraint failed: a.email'), {
      code: 'ERR_SQLITE_ERROR',
      errcode: 2067,
    }),
  },
];

describe('classifyDriverError — duplicate-key signals (409, not retryable)', () => {
  for (const { backend, error, adapterType } of DUPLICATE_SIGNALS) {
    it(backend, () => {
      expect(classifyDriverError(error, adapterType)).toBe('duplicate');
    });
  }

  it('reads MongoDB 11000 and Cosmos 409 only under their own adapter', () => {
    // Numeric codes are backend-local: Bigtable's gRPC 11 or an HTTP-ish 409
    // from another backend must not read as a duplicate key.
    expect(classifyDriverError({ code: 11000 }, 'cosmos')).toBeNull();
    expect(classifyDriverError({ code: 11000 }, 'bigtable')).toBeNull();
    expect(classifyDriverError({ code: 409 }, 'mongodb')).toBeNull();
    expect(classifyDriverError({ code: 409 })).toBeNull();
  });

  it('leaves other SQLite constraint failures alone', () => {
    expect(classifyDriverError(new Error('NOT NULL constraint failed: a.email'))).toBeNull();
    expect(classifyDriverError(new Error('CHECK constraint failed: positive'))).toBeNull();
  });

  it('a duplicate signal outranks a retryable label beside it', () => {
    expect(classifyDriverError({
      code: 11000,
      errorLabels: ['TransientTransactionError'],
    }, 'mongodb')).toBe('duplicate');
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
    top.name = 'TimeoutError';
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
    expect(classifyDriverError({ code: '23502' })).toBe(null); // not_null_violation
    expect(classifyDriverError({ code: '40003' })).toBe(null); // completion unknown
  });

  it('does not read backend-local numeric codes under the wrong adapter', () => {
    expect(classifyDriverError({ code: 10 }, 'mongodb')).toBe(null);
    expect(classifyDriverError({ code: 14 }, 'mongodb')).toBe(null);
    expect(classifyDriverError({ code: 449 }, 'bigtable')).toBe(null);
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

  it('a DuplicateKeyError returns null — the adapters raise it themselves', () => {
    expect(classifyDriverError(new DuplicateKeyError('dup', { cause: { code: '23505' } })))
      .toBeNull();
  });

  it('a package-owned DatabaseUnavailableError returns null too', () => {
    const mine = new DatabaseUnavailableError('pool exhausted', { cause: { code: '08006' } });
    expect(classifyDriverError(mine)).toBe(null);
  });
});
