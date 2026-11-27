import { describe, expect, it } from 'vitest';
import { DrizzleQueryError } from 'drizzle-orm';
import { httpStatusHintOf, withHttpStatusHint } from '@setu-ts/common';
import type { IDatabaseAdapter, IDataSource } from '@setu-ts/common';
import type { DatabaseAdapterType } from '../../src/interfaces/index.ts';
import { DatabaseService } from '../../src/services/database-service.ts';
import {
  DatabaseTimeoutError,
  DatabaseUnavailableError,
  ForeignKeyViolationError,
  NotNullViolationError,
  SerializationConflictError,
} from '../../src/errors.ts';

const source: IDataSource = {
  findAll: () => Promise.resolve([]),
  findById: () => Promise.resolve(null),
  create: (data) => Promise.resolve(data),
  update: (_id, data) => Promise.resolve(data),
  delete: () => Promise.resolve(false),
  count: () => Promise.resolve(0),
};

function service(commitError?: unknown, backend: DatabaseAdapterType = 'custom'): DatabaseService {
  const adapter: IDatabaseAdapter = {
    connect: () => Promise.resolve(),
    disconnect: () => Promise.resolve(),
    isReady: () => true,
    createDataSource: () => source,
    rawQuery: () => Promise.resolve([]),
    beginTransaction: () =>
      Promise.resolve({
        createDataSource: () => source,
        commit: () => (commitError === undefined ? Promise.resolve() : Promise.reject(commitError)),
        rollback: () => Promise.resolve(),
      }),
  };
  return new DatabaseService(adapter, () => source, backend);
}

const adapterCause = (kind: string, originalCode?: string) => ({
  code: 'P2010',
  meta: {
    driverAdapterError: {
      cause: { kind, ...(originalCode === undefined ? {} : { originalCode }) },
    },
  },
});

/** The database-only signal vocabulary at the transaction-work boundary. */
const IN: readonly (readonly [string, unknown, number])[] = [
  [
    'Mongo numeric code beside conflict label',
    { name: 'MongoServerError', code: 112, errorLabels: ['TransientTransactionError'] },
    409,
  ],
  ['Mongo name beside errno', { name: 'MongoNetworkError', code: 'ECONNRESET' }, 503],
  ['SQLSTATE beside generic timeout name', { name: 'TimeoutError', code: '40001' }, 409],
  ...['40001', '40P01', '55P03', 'P2034', 'ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT'].map(
    (code) => [code, { code }, 409] as const,
  ),
  ...[
    '08006',
    '57P01',
    '57P03',
    '53300',
    'P1001',
    'P2028',
    'P2037',
    'ER_SERVER_SHUTDOWN',
    'ER_CON_COUNT_ERROR',
    'ER_TOO_MANY_USER_CONNECTIONS',
    'SQLITE_BUSY',
  ].map((code) => [code, { code }, 503] as const),
  ...['P1017', 'P1008', 'PROTOCOL_CONNECTION_LOST'].map((code) => [code, { code }, 504] as const),
  ...[
    '23505',
    'P2002',
    'ER_DUP_ENTRY',
    '23503',
    '23001',
    'P2003',
    'ER_NO_REFERENCED_ROW_2',
    'ER_ROW_IS_REFERENCED_2',
  ].map((code) => [code, { code }, 409] as const),
  ...['23502', 'P2011', 'ER_BAD_NULL_ERROR', 'ER_NO_DEFAULT_FOR_FIELD'].map(
    (code) => [code, { code }, 400] as const,
  ),
  ...(
    [
      'UniqueConstraintViolation',
      'TransactionWriteConflict',
      'ForeignKeyConstraintViolation',
      'RestrictViolation',
    ] as const
  ).map((kind) => [kind, adapterCause(kind), 409] as const),
  ['NullConstraintViolation', adapterCause('NullConstraintViolation'), 400],
  ...['ConnectionClosed', 'SocketTimeout'].map((kind) => [kind, adapterCause(kind), 504] as const),
  ...['DatabaseNotReachable', 'TooManyConnections'].map(
    (kind) => [kind, adapterCause(kind), 503] as const,
  ),
  ...['45028', '45013', '1053'].map(
    (code) => ['mariadb ' + code, adapterCause('mysql', code), 503] as const,
  ),
  ['mariadb closed', adapterCause('mysql', '45009'), 504],
  ['mariadb lock', adapterCause('mysql', '1205'), 409],
  ['Mongo label', { errorLabels: ['TransientTransactionError'] }, 409],
  ['Dynamo name', { name: 'TransactionConflictException' }, 409],
  ...[
    'MongoNetworkError',
    'MongoPoolClearedError',
    'MongoServerSelectionError',
    'MongoWaitQueueTimeoutError',
  ].map((name) => [name, { name }, 503] as const),
  ...['MongoNetworkTimeoutError', 'MongoOperationTimeoutError'].map(
    (name) => [name, { name }, 504] as const,
  ),
  ['pg pool', new Error('timeout exceeded when trying to connect'), 503],
  ['pg handshake', new Error('Connection terminated due to connection timeout'), 503],
  ['pg query', new Error('Query read timeout'), 504],
  ['pg lost', new Error('Connection terminated unexpectedly'), 504],
  ...[
    "Can't add new command when connection is in closed state",
    'Client has encountered a connection error and is not queryable',
    'Client was closed and is not queryable',
  ].map((message) => [message, new Error(message), 503] as const),
  ...['', 'D1_ERROR: '].flatMap((prefix) => [
    [prefix + 'unique', new Error(prefix + 'UNIQUE constraint failed: t.id'), 409] as const,
    [prefix + 'FK', new Error(prefix + 'FOREIGN KEY constraint failed'), 409] as const,
    [
      prefix + 'not null',
      Object.assign(new Error(prefix + 'NOT NULL constraint failed: t.value'), {
        code: 'ERR_SQLITE_ERROR',
      }),
      400,
    ] as const,
  ]),
];

describe('transaction work classification', () => {
  it('Mongo UnknownTransactionCommitResult keeps the original even beside a conflict label', async () => {
    const error = {
      name: 'MongoServerError',
      code: 112,
      errorLabels: ['TransientTransactionError', 'UnknownTransactionCommitResult'],
    };
    await expect(service(error, 'mongodb').transaction(() => Promise.resolve())).rejects.toBe(
      error,
    );
    await expect(
      service({ ...error, errorLabels: ['TransientTransactionError'] }, 'mongodb').transaction(() =>
        Promise.resolve(),
      ),
    ).rejects.toBeInstanceOf(SerializationConflictError);
  });
  it('a Bigtable commit ABORTED is a verdict while UNAVAILABLE has an unknown outcome', async () => {
    await expect(
      service({ code: 10 }, 'bigtable').transaction(() => Promise.resolve()),
    ).rejects.toBeInstanceOf(SerializationConflictError);
    const unavailable = { code: 14 };
    await expect(
      service(unavailable, 'bigtable').transaction(() => Promise.resolve()),
    ).rejects.toBe(unavailable);
  });
  it('ignores deeper signals and reasons even when the thrown error has its own database name', async () => {
    const error = Object.assign(new Error('driver', { cause: { code: '40001' } }), {
      name: 'MongoNetworkError',
    });
    const result = await service(undefined, 'mongodb')
      .transaction(() => Promise.reject(error))
      .catch((value: unknown) => value);
    expect(httpStatusHintOf(result)?.status).toBe(503);
    const conflict = Object.assign(new Error('driver', { cause: { code: '55P03' } }), {
      code: '40001',
    });
    const refused = await service()
      .transaction(() => Promise.reject(conflict))
      .catch((value: unknown) => value);
    expect(refused).toHaveProperty('reason', 'write-conflict');
  });
  it('constructs each reason from the raw signal before diagnostic scrubbing', async () => {
    for (const [input, reason, slug] of [
      [
        new Error('timeout exceeded when trying to connect'),
        'pool-saturated',
        'database-pool-saturated',
      ],
      [adapterCause('mysql', '45028'), 'unreachable', 'database-unavailable'],
      [adapterCause('ConnectionClosed'), 'connection-lost', 'database-connection-lost'],
      [{ name: 'TimeoutError', code: 'ECONNRESET' }, 'connection-lost', 'database-connection-lost'],
      [{ code: 'P1008' }, 'bound', 'database-timeout'],
      [{ code: '40001' }, 'write-conflict', 'write-conflict'],
      [{ code: '55P03' }, 'lock-timeout', 'lock-timeout'],
    ] as const) {
      const adapter: IDatabaseAdapter = {
        connect: () => Promise.resolve(),
        disconnect: () => Promise.resolve(),
        isReady: () => true,
        createDataSource: () => source,
        rawQuery: () => Promise.reject(input),
        beginTransaction: () => Promise.reject(input),
      };
      const db = new DatabaseService(adapter, () => source, 'custom');
      for (const call of [
        () => db.query('select'),
        () => db.transaction(() => Promise.resolve()),
      ]) {
        const error = await call().catch((value: unknown) => value);
        expect(error).toHaveProperty('reason', reason);
        expect(httpStatusHintOf(error)?.problem?.type).toBe(`https://setu-ts.dev/errors/${slug}`);
      }
    }
  });
  it('preserves classified errors and keeps the entity on constraint refusals', async () => {
    for (const ErrorClass of [ForeignKeyViolationError, NotNullViolationError]) {
      const original = new ErrorClass('fixed', { cause: { code: '40001' } });
      await expect(service().transaction(() => Promise.reject(original))).rejects.toBe(original);
      const code = ErrorClass === ForeignKeyViolationError ? '23503' : '23502';
      const adapter: IDatabaseAdapter = {
        connect: () => Promise.resolve(),
        disconnect: () => Promise.resolve(),
        isReady: () => true,
        createDataSource: () => source,
        rawQuery: () => Promise.resolve([]),
        beginTransaction: () => Promise.reject(new Error('unused')),
      };
      const db = new DatabaseService(
        adapter,
        () => ({ ...source, create: () => Promise.reject({ code }) }),
        'custom',
      );
      const thrown = await db
        .getRepository('Account')
        .create({ id: 'private' })
        .catch((value: unknown) => value);
      expect(thrown).toBeInstanceOf(ErrorClass);
      expect(thrown).toHaveProperty('entity', 'Account');
    }
    for (const original of [
      new DatabaseTimeoutError('fixed'),
      new DatabaseUnavailableError('fixed'),
      new SerializationConflictError('fixed'),
    ]) {
      await expect(service(original).transaction(() => Promise.resolve())).rejects.toBe(original);
    }
  });
  for (const [label, error, status] of IN) {
    it(`in: ${label}, direct and Drizzle query wrapper`, async () => {
      for (const rejection of [
        error,
        Object.assign(new Error('Failed query', { cause: error }), {
          query: 'select 1',
          params: [],
        }),
      ]) {
        const thrown = await service()
          .transaction(() => Promise.reject(rejection))
          .catch((value: unknown) => value);
        expect(thrown).not.toBe(rejection);
        expect(httpStatusHintOf(thrown)?.status).toBe(status);
      }
    });
  }
  const hintedQuery = withHttpStatusHint(
    new Error('Application refusal', {
      cause: new DrizzleQueryError(
        'insert into accounts values ($1)',
        ['bound-secret'],
        new Error('driver'),
      ),
    }),
    { status: 422, title: 'Application', detail: 'Application refusal.' },
  );
  const OUT: readonly (readonly [string, unknown, DatabaseAdapterType?])[] = [
    ['hinted app error with a private Drizzle cause', hintedQuery],
    ...[
      'ECONNREFUSED',
      'ECONNRESET',
      'ETIMEDOUT',
      'EHOSTUNREACH',
      'ENETUNREACH',
      'ENOTFOUND',
      'EAI_AGAIN',
      'EPIPE',
    ].map((code) => [code, { code }] as const),
    ...['TimeoutError', 'NetworkingError'].map((name) => [name, { name }] as const),
    ['smithy code', { name: 'TimeoutError', code: 'ECONNRESET' }],
    ['Cosmos timeout', { code: 'TimeoutError', name: 'TimeoutError' }, 'cosmos'],
    ...[4, 10, 14].map((code) => ['gRPC ' + code, { code }, 'bigtable'] as const),
    ...[409, 429, 449, 503].map((code) => ['Cosmos ' + code, { code }, 'cosmos'] as const),
    ['Mongo numeric', { code: 11000 }, 'mongodb'],
    ['Mongo primary verdict', { code: 10107 }, 'mongodb'],
    ['bare mariadb', { code: '1205' }],
    ['app cause', new Error('application', { cause: { code: '40001' } })],
    [
      'app status',
      withHttpStatusHint(new Error('application', { cause: { code: '40001' } }), {
        status: 422,
        title: 'Application',
        detail: 'Application refusal.',
      }),
    ],
    ['lookalike wrapper', { query: 'select', params: [], cause: { code: '40001' } }],
    [
      'wrong params',
      Object.assign(new Error('application', { cause: { code: '40001' } }), {
        query: 'select',
        params: {},
      }),
    ],
    ['raw value', { code: '22001' }],
    [
      'hostile wrapper',
      new Proxy(
        {},
        {
          get() {
            throw new Error('hostile');
          },
        },
      ),
    ],
    ['unknown', new Error('application')],
  ];
  for (const [label, error, backend] of OUT) {
    it(`out: ${label} stays itself`, async () => {
      await expect(
        service(undefined, backend).transaction(() => Promise.reject(error)),
      ).rejects.toBe(error);
      if (error === hintedQuery) {
        expect(hintedQuery.cause).not.toHaveProperty('params');
        expect((hintedQuery.cause as Error).message).toBe(
          'Failed query: insert into accounts values ($1)',
        );
        expect((hintedQuery.cause as Error).stack).not.toContain('bound-secret');
        expect(JSON.stringify(hintedQuery)).not.toContain('bound-secret');
        expect(httpStatusHintOf(hintedQuery)?.status).toBe(422);
      }
    });
  }
  for (const [label, error, status] of IN.filter(
    ([, , status]) => status === 409 || status === 400,
  )) {
    it(`commit verdict: ${label}`, async () => {
      const thrown = await service(error)
        .transaction(() => Promise.resolve())
        .catch((value: unknown) => value);
      expect(httpStatusHintOf(thrown)?.status).toBe(status);
    });
  }
  for (const error of [
    { code: 'ECONNRESET' },
    { code: 'P1017' },
    { code: '53300' },
    { code: '40001', errorLabels: ['UnknownTransactionCommitResult'] },
    { code: '23503', cause: { errorLabels: ['UnknownTransactionCommitResult'] } },
  ]) {
    it(`commit unknown outcome stays itself: ${JSON.stringify(error)}`, async () => {
      await expect(service(error).transaction(() => Promise.resolve())).rejects.toBe(error);
    });
  }
});

describe('a tagged driver error that the scrub replaces keeps its status', () => {
  const tagged = (): Error =>
    withHttpStatusHint(
      Object.assign(new Error('invalid input syntax for type integer: "tagged-secret"'), {
        code: '22P02',
      }),
      { status: 400, title: 'Bad Request', detail: 'The value is not a number.' },
    );
  const check = (thrown: unknown): void => {
    expect(httpStatusHintOf(thrown)?.status).toBe(400);
    expect((thrown as Error).message).not.toContain('tagged-secret');
    expect(String((thrown as Error).stack)).not.toContain('tagged-secret');
  };
  it('from transaction work', async () => {
    const thrown = await service()
      .transaction(() => Promise.reject(tagged()))
      .catch((error: unknown) => error);
    check(thrown);
  });
  it('from a repository call', async () => {
    const failing: IDataSource = { ...source, findAll: () => Promise.reject(tagged()) };
    const adapter: IDatabaseAdapter = {
      connect: () => Promise.resolve(),
      disconnect: () => Promise.resolve(),
      isReady: () => true,
      createDataSource: () => failing,
      rawQuery: () => Promise.resolve([]),
      beginTransaction: () => Promise.reject(new Error('unused')),
    };
    const thrown = await new DatabaseService(adapter, () => failing, 'custom')
      .getRepository('Item')
      .findAll()
      .catch((error: unknown) => error);
    check(thrown);
  });
});
