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
import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { classifyDriverError, isUnansweredConnect } from '../../src/errors/classify.ts';
import {
  DatabaseTimeoutError,
  DatabaseUnavailableError,
  SerializationConflictError,
} from '../../src/errors.ts';
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
    expect(classifyDriverError(new Error('timeout exceeded when trying to connect'))).toBe(
      'unavailable',
    );
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
  it('classifies a real node:sqlite duplicate even with its string code', () => {
    const database = new DatabaseSync(':memory:');
    try {
      database.exec('CREATE TABLE t (id INTEGER PRIMARY KEY); INSERT INTO t VALUES (1)');
      let error: unknown;
      try {
        database.exec('INSERT INTO t VALUES (1)');
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({
        message: 'UNIQUE constraint failed: t.id',
        code: 'ERR_SQLITE_ERROR',
        errcode: 1555,
      });
      expect(classifyDriverError(error, 'drizzle')).toBe('duplicate');
      expect(classifyDriverError(new Error('Failed query', { cause: error }))).toBe('duplicate');
    } finally {
      database.close();
    }
  });

  for (const anchor of [
    'UNIQUE constraint failed',
    'UNIQUE constraint failed: t.id',
    'D1_ERROR: UNIQUE constraint failed: t.id',
  ]) {
    it(`does not classify quoted SQLite anchor ${anchor} as a duplicate`, () => {
      const driver = Object.assign(
        new Error(`invalid input syntax for type integer: "${anchor}"`),
        { code: '22P02' },
      );
      for (const error of [
        driver,
        new Error(`Failed query: insert into "numbers" values ($1)\nparams: ${anchor}`, {
          cause: driver,
        }),
        new Error(`Failed query: insert into "numbers" values ($1)\nparams: ${anchor}`),
      ]) {
        expect(classifyDriverError(error, 'drizzle')).toBeNull();
      }
    });
  }

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
    expect(
      classifyDriverError(
        {
          code: 11000,
          errorLabels: ['TransientTransactionError'],
        },
        'mongodb',
      ),
    ).toBe('duplicate');
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
    expect(
      classifyDriverError(new DuplicateKeyError('dup', { cause: { code: '23505' } })),
    ).toBeNull();
  });

  it('a package-owned DatabaseUnavailableError returns null too', () => {
    const mine = new DatabaseUnavailableError('pool exhausted', { cause: { code: '08006' } });
    expect(classifyDriverError(mine)).toBe(null);
  });
});

describe('M113g measured pg timeout signals', () => {
  for (const [message, expected] of [
    ['timeout exceeded when trying to connect', 'unavailable'],
    ['Connection terminated due to connection timeout', 'unavailable'],
    ['Query read timeout', 'timeout'],
  ] as const) {
    it(`classifies ${message} including Drizzle wrappers`, () => {
      const error = new Error(message);
      expect(classifyDriverError(error, 'drizzle')).toBe(expected);
      expect(classifyDriverError(new Error('Failed query', { cause: error }), 'drizzle')).toBe(
        expected,
      );
      expect(isUnansweredConnect(error)).toBe(true);
      expect(isUnansweredConnect(new Error('Failed query', { cause: error }))).toBe(true);
    });
    it(`does not classify client text quoting ${message} as a pg timeout`, () => {
      const driver = Object.assign(
        new Error(`invalid input syntax for type integer: "${message}"`),
        { code: '22P02' },
      );
      const wrapper = new Error(
        `Failed query: insert into "numbers" values ($1)\nparams: ${message}`,
        {
          cause: driver,
        },
      );
      for (const error of [
        driver,
        wrapper,
        new Error(`prefix ${message}`),
        new Error(`${message}\n`),
      ]) {
        expect(classifyDriverError(error, 'drizzle')).toBeNull();
        expect(isUnansweredConnect(error)).toBe(false);
      }
    });
    it(`a string code anywhere in the chain vetoes the exact pg message ${message}`, () => {
      for (const code of ['22P02', '']) {
        for (const error of [
          Object.assign(new Error(message), { code }),
          new Error(message, { cause: { code } }),
          Object.assign(new Error('Failed query', { cause: new Error(message) }), { code }),
        ]) {
          expect(classifyDriverError(error, 'drizzle')).toBeNull();
          expect(isUnansweredConnect(error)).toBe(false);
        }
      }
      const numericCode = Object.assign(new Error(message), { code: 123 });
      expect(classifyDriverError(numericCode, 'drizzle')).toBe(expected);
      expect(isUnansweredConnect(numericCode)).toBe(true);
    });
  }
  it('passes already classified timeouts through without rewrapping', () => {
    expect(
      classifyDriverError(
        new DatabaseTimeoutError('bounded', { cause: new Error('Query read timeout') }),
      ),
    ).toBeNull();
    expect(isUnansweredConnect({ code: 'ECONNREFUSED' })).toBe(false);
  });
});

describe('M119e refusedInputOf', () => {
  it('matches the PostgreSQL refusal table, including bounded nested causes', async () => {
    const { refusedInputOf } = await import('../../src/errors/classify.ts');
    const cases: readonly (readonly [unknown, unknown])[] = [
      ...['22P02', '22003', '22007', '22008'].map((code) => [{ code }, { kind: 'value' }] as const),
      [{ cause: { code: '22P02' } }, { kind: 'value' }],
      [{ code: '22012' }, null],
      [{ code: '23505' }, null],
      [{ code: 'P2007' }, null],
      [null, null],
      ['foreign', null],
    ];
    for (const [input, expected] of cases) expect(refusedInputOf(input)).toEqual(expected);
  });
});

// Exact Prisma 7 diagnostics measured by the M119e real-backend probe.
const PRISMA_REFUSALS = [
  {
    label: 'malformed uuid findById',
    name: 'PrismaClientKnownRequestError',
    code: 'P2007',
    message:
      '\nInvalid `client.portableValue.findUnique()` invocation in\n/app/prisma-probe.mts:12:60\n\n   9 const client = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });\n  10 try {\n  11   for (const [label, work] of [\n\u2192 12     [\'malformed uuid findById\', () => client.portableValue.findUnique(\nInvalid input value: invalid input syntax for type uuid: "abc"',
  },
  {
    label: 'mistyped integer create',
    name: 'PrismaClientValidationError',
    code: null,
    message:
      "\nInvalid `client.portableValue.create()` invocation in\n/app/prisma-probe.mts:13:60\n\n  10 try {\n  11   for (const [label, work] of [\n  12     ['malformed uuid findById', () => client.portableValue.findUnique({ where: { id: 'abc' } })],\n\u2192 13     ['mistyped integer create', () => client.portableValue.create({\n           data: {\n             id: \"70d0c8db-60af-4860-a55a-15fa81559b2f\",\n             age: \"canary-value\"\n                  ~~~~~~~~~~~~~~\n           }\n         })\n\nArgument `age`: Invalid value provided. Expected Int, provided String.",
  },
  {
    label: 'unknown field create',
    name: 'PrismaClientValidationError',
    code: null,
    message:
      "\nInvalid `client.portableValue.create()` invocation in\n/app/prisma-probe.mts:14:57\n\n  11 for (const [label, work] of [\n  12   ['malformed uuid findById', () => client.portableValue.findUnique({ where: { id: 'abc' } })],\n  13   ['mistyped integer create', () => client.portableValue.create({ data: { id: crypto.randomUUID(), age: 'canary-value' } })],\n\u2192 14   ['unknown field create', () => client.portableValue.create({\n         data: {\n           id: \"8d6f99f1-a5af-4b82-ab4a-eee97d5a5fd8\",\n           age: 1,\n           surprise: \"canary-value\"\n           ~~~~~~~~\n         }\n       })\n\nUnknown argument `surprise`. Available options are marked with ?.",
  },
];

describe('M119e measured Prisma input refusals', () => {
  for (const [index, row] of PRISMA_REFUSALS.entries()) {
    it(row.label, async () => {
      const { refusedInputOf } = await import('../../src/errors/classify.ts');
      const error = Object.assign(new Error(row.message), {
        name: row.name,
        ...(row.code === null ? {} : { code: row.code }),
      });
      const expected =
        index === 2 ? { kind: 'unknown-field', field: 'surprise' } : { kind: 'value' };
      expect(refusedInputOf(error)).toEqual(expected);
      expect(refusedInputOf(new Error('wrapper', { cause: error }))).toEqual(expected);
    });
  }
  it('matches P2007 only on known-request errors and leaves other codes alone', async () => {
    const { refusedInputOf } = await import('../../src/errors/classify.ts');
    expect(refusedInputOf({ name: 'PrismaClientKnownRequestError', code: 'P2007' })).toEqual({
      kind: 'value',
    });
    expect(refusedInputOf({ name: 'OtherError', code: 'P2007' })).toBeNull();
    // P2023 also reports stored data Prisma cannot read: a server fault, kept unmapped.
    expect(refusedInputOf({ name: 'PrismaClientKnownRequestError', code: 'P2023' })).toBeNull();
    expect(refusedInputOf({ name: 'PrismaClientKnownRequestError', code: 'P2002' })).toBeNull();
    expect(refusedInputOf({ name: 'PrismaClientValidationError' })).toEqual({ kind: 'value' });
    expect(refusedInputOf({ message: 'Unknown argument `surprise`' })).toBeNull();
  });
  it('names the key from Prisma summary line, never from a rendered payload value (audit F-2)', async () => {
    const { refusedInputOf } = await import('../../src/errors/classify.ts');
    // The measured shape, with a payload value carrying the summary text: the
    // rendered value sits indented after its key, above Prisma's own line.
    const message =
      '\nInvalid `client.portableValue.create()` invocation:\n\n{\n  data: {\n' +
      '    id: "Unknown argument `forged_by_value`",\n    age: 1,\n' +
      '    real_unknown_key: 2\n    ~~~~~~~~~~~~~~~~\n  }\n}\n\n' +
      'Unknown argument `real_unknown_key`. Available options are marked with ?.';
    const error = Object.assign(new Error(message), { name: 'PrismaClientValidationError' });
    expect(refusedInputOf(error)).toEqual({ kind: 'unknown-field', field: 'real_unknown_key' });
    // A value alone, with no summary line of Prisma's, names no field.
    const valueOnly = Object.assign(
      new Error('\n  data: {\n    id: "Unknown argument `forged_by_value`"\n  }\n'),
      { name: 'PrismaClientValidationError' },
    );
    expect(refusedInputOf(valueOnly)).toEqual({ kind: 'value' });
  });
});
