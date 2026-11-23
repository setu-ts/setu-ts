/**
 * The inject-or-lazy client seam and its adaptation of the SDK shape.
 *
 * The lazy arm's literal `import('npm:@google-cloud/bigtable@^6')` is exercised
 * for real in `test/integration/real-import.test.ts`; everything AROUND it —
 * which arm is chosen, and how the SDK's tuple-returning surface becomes the
 * facade — is unit-tested here against a fake module, so no branch hides behind
 * a guarded import.
 *
 * @module
 */
import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type {
  BigtableFilter,
  IBigtableClient,
} from '../../src/adapters/bigtable/bigtable-client-types.ts';
import {
  adaptBigtableSdk,
  adaptBigtableSdkModule,
  type BigtableClientConfiguration,
  type BigtableEnvironmentFacts,
  type BigtableSdkModule,
  createInjectedBigtableLoader,
  createLazyBigtableLoader,
} from '../../src/adapters/bigtable/bigtable-client.ts';

/** Everything the fake SDK module saw. */
interface SdkLog {
  configuration?: Readonly<Record<string, unknown>>;
  instances: string[];
  tables: string[];
  reads: unknown[];
  filters: unknown[];
  branches: unknown[];
  closes: number;
}

/** Builds a structural stand-in for the native SDK module. */
function fakeModule(log: SdkLog, rows: { id: string; data?: unknown }[] = []): BigtableSdkModule {
  return {
    Bigtable: class {
      constructor(configuration: Readonly<Record<string, unknown>> & { projectId: string }) {
        log.configuration = configuration;
      }
      instance(id: string) {
        log.instances.push(id);
        return {
          table: (tableId: string) => {
            log.tables.push(tableId);
            return {
              // The SDK resolves every call to a one-element tuple; adapting
              // that once is the whole point of this seam.
              getRows: (options: unknown) => {
                log.reads.push(options);
                return Promise.resolve([rows as { id: string }[]] as [
                  readonly { id: string }[],
                  ...unknown[],
                ]);
              },
              row: (key: string) => ({
                filter: (test: readonly unknown[], branches: unknown) => {
                  log.filters.push({ key, test });
                  log.branches.push(branches);
                  return Promise.resolve([true] as [boolean, ...unknown[]]);
                },
              }),
            };
          },
        };
      }
      close() {
        log.closes += 1;
        return Promise.resolve(undefined);
      }
    },
  };
}

/** A fresh, empty log. */
function newLog(): SdkLog {
  return {
    instances: [],
    tables: [],
    reads: [],
    filters: [],
    branches: [],
    closes: 0,
  };
}

describe('loaders', () => {
  it('resolves an injected client verbatim and reports it unowned', async () => {
    const client = { instance: () => ({ table: () => ({}) }), close: () => Promise.resolve() };
    const loader = createInjectedBigtableLoader(client as unknown as IBigtableClient);
    expect(loader.owned).toBe(false);
    expect(await loader.load()).toBe(client);
  });

  it('reports a lazy loader as owned without importing anything at construction', () => {
    // The literal `import()` sits inside `load()`, so building the loader for a
    // project that never connects costs nothing.
    expect(createLazyBigtableLoader({ projectId: 'p' }).owned).toBe(true);
  });
});

/**
 * When the lazy arm defaults `universeDomain`: against an emulator (the
 * environment's, or an endpoint with no `sslCreds`), and only when no universe
 * is configured in `clientOptions` or the environment.
 */
const universeCases: readonly {
  readonly name: string;
  readonly environment: BigtableEnvironmentFacts;
  readonly configuration: BigtableClientConfiguration;
  readonly universeDomain: string | undefined;
  readonly metricsEnabled: false | undefined;
}[] = [
  {
    name: 'no endpoint and no emulator variable',
    environment: {},
    configuration: { projectId: 'p' },
    universeDomain: undefined,
    metricsEnabled: undefined,
  },
  {
    name: 'the emulator variable set',
    environment: { emulatorFromEnvironment: true },
    configuration: { projectId: 'p' },
    universeDomain: 'googleapis.com',
    metricsEnabled: false,
  },
  {
    name: 'the emulator variable set, sslCreds given',
    environment: { emulatorFromEnvironment: true },
    configuration: { projectId: 'p', clientOptions: { sslCreds: 'tls' } },
    universeDomain: 'googleapis.com',
    metricsEnabled: false,
  },
  {
    name: 'apiEndpoint without sslCreds',
    environment: {},
    configuration: { projectId: 'p', apiEndpoint: '127.0.0.1:8086' },
    universeDomain: 'googleapis.com',
    metricsEnabled: false,
  },
  {
    name: 'apiEndpoint with sslCreds',
    environment: {},
    configuration: {
      projectId: 'p',
      apiEndpoint: 'bigtable.example.test',
      clientOptions: { sslCreds: 'tls' },
    },
    universeDomain: undefined,
    metricsEnabled: false,
  },
  {
    name: 'clientOptions.apiEndpoint without sslCreds',
    environment: {},
    configuration: { projectId: 'p', clientOptions: { apiEndpoint: '127.0.0.1:8086' } },
    universeDomain: 'googleapis.com',
    metricsEnabled: false,
  },
  {
    name: 'clientOptions.apiEndpoint with sslCreds',
    environment: {},
    configuration: {
      projectId: 'p',
      clientOptions: { apiEndpoint: 'bigtable.example.test', sslCreds: 'tls' },
    },
    universeDomain: undefined,
    metricsEnabled: false,
  },
  {
    name: 'clientOptions.universeDomain set, passed unchanged',
    environment: { emulatorFromEnvironment: true },
    configuration: {
      projectId: 'p',
      apiEndpoint: '127.0.0.1:8086',
      clientOptions: { universeDomain: 'example.test' },
    },
    universeDomain: 'example.test',
    metricsEnabled: false,
  },
  {
    name: 'clientOptions.universe_domain set',
    environment: {},
    configuration: {
      projectId: 'p',
      apiEndpoint: '127.0.0.1:8086',
      clientOptions: { universe_domain: 'example.test' },
    },
    universeDomain: undefined,
    metricsEnabled: false,
  },
  {
    name: 'the universe variable set, with the emulator variable',
    environment: { emulatorFromEnvironment: true, universeFromEnvironment: true },
    configuration: { projectId: 'p' },
    universeDomain: undefined,
    metricsEnabled: false,
  },
  {
    name: 'the universe variable set, with apiEndpoint',
    environment: { universeFromEnvironment: true },
    configuration: { projectId: 'p', apiEndpoint: '127.0.0.1:8086' },
    universeDomain: undefined,
    metricsEnabled: false,
  },
];

describe('the emulator universe default', () => {
  for (const row of universeCases) {
    it(`${row.universeDomain === undefined ? 'omits' : 'passes'} universeDomain: ${row.name}`, () => {
      const log = newLog();
      adaptBigtableSdk(fakeModule(log), row.configuration, row.environment);
      expect(log.configuration?.['universeDomain']).toBe(row.universeDomain);
      expect('universeDomain' in log.configuration!).toBe(row.universeDomain !== undefined);
      expect(log.configuration?.['metricsEnabled']).toBe(row.metricsEnabled);
      expect('emulatorFromEnvironment' in log.configuration!).toBe(false);
      expect('universeFromEnvironment' in log.configuration!).toBe(false);
    });
  }

  it('decides from options alone through the exported adapter', () => {
    const log = newLog();
    adaptBigtableSdkModule(fakeModule(log), { projectId: 'p' });
    expect(log.configuration).toEqual({ projectId: 'p' });
  });
});

describe('adaptBigtableSdkModule', () => {
  for (const [configuration, expected] of [
    [{ projectId: 'p' }, { projectId: 'p' }],
    [
      {
        projectId: 'p',
        clientOptions: { apiEndpoint: 'localhost:8086', projectId: 'ignored', custom: 'kept' },
      },
      {
        projectId: 'p',
        apiEndpoint: 'localhost:8086',
        metricsEnabled: false,
        universeDomain: 'googleapis.com',
        custom: 'kept',
      },
    ],
    [
      { projectId: 'p', apiEndpoint: 'localhost:8086', clientOptions: { metricsEnabled: true } },
      {
        projectId: 'p',
        apiEndpoint: 'localhost:8086',
        metricsEnabled: true,
        universeDomain: 'googleapis.com',
      },
    ],
    [
      { projectId: 'p', clientOptions: { metricsEnabled: false } },
      { projectId: 'p', metricsEnabled: false },
    ],
  ] satisfies readonly [BigtableClientConfiguration, object][]) {
    it(`resolves client options and emulator metrics ${JSON.stringify(configuration)}`, () => {
      const log = newLog();
      adaptBigtableSdkModule(fakeModule(log), configuration);
      expect(log.configuration).toEqual(expected);
    });
  }
  it('passes gax deadlines and the latest-column filter to SDK calls', async () => {
    const log = newLog();
    const client = adaptBigtableSdkModule(fakeModule(log), { projectId: 'p' });
    const table = client.instance('i').table('t');
    await table.readRows({ filter: { column: { cellLimit: 1 } } }, { timeoutMs: 123 });
    await table.row('a').conditionalMutate([{ all: true }], {}, { timeoutMs: 456 });
    expect(log.reads[0]).toEqual({
      filter: { column: { cellLimit: 1 } },
      gaxOptions: { timeout: 123 },
    });
    expect(log.branches[0]).toEqual({ gaxOptions: { timeout: 456 } });
  });
  for (const mode of ['rows', 'error', 'hanging'] as const)
    it(`bounds the whole ReadRows stream: ${mode}`, async () => {
      let ended = 0;
      const fault = new Error('stream failed');
      const module: BigtableSdkModule = {
        Bigtable: class {
          instance() {
            return {
              table: () => ({
                getRows: () => Promise.resolve([[]] as [readonly { id: string }[]]),
                createReadStream: () => {
                  const stream = Object.assign(new EventEmitter(), {
                    end: () => {
                      ended += 1;
                      stream.emit('end');
                    },
                  });
                  queueMicrotask(() => {
                    if (mode === 'rows') {
                      stream.emit('data', { id: 'a' });
                      stream.emit('end');
                    }
                    if (mode === 'error') {
                      stream.emit('error', fault);
                      stream.emit('end');
                    }
                    // In hanging mode the SDK may retry internally; no new stream gets a fresh timer.
                  });
                  return stream;
                },
                row: () => ({ filter: () => Promise.resolve([true] as [boolean]) }),
              }),
            };
          }
          close() {
            return Promise.resolve();
          }
        },
      };
      const client = adaptBigtableSdkModule(module, { projectId: 'p' });
      const call = client.instance('i').table('t').readRows({}, { timeoutMs: 20 });
      if (mode === 'rows') expect(await call).toEqual([{ key: 'a', data: {} }]);
      else if (mode === 'error') await expect(call).rejects.toBe(fault);
      else {
        await expect(call).rejects.toMatchObject({ code: 4 });
        expect(ended).toBe(1);
      }
      await client.close();
    });
  it('passes the configuration to the native constructor', () => {
    const log = newLog();
    adaptBigtableSdkModule(fakeModule(log), { projectId: 'p', apiEndpoint: '127.0.0.1:8086' });
    expect(log.configuration).toEqual({
      projectId: 'p',
      apiEndpoint: '127.0.0.1:8086',
      metricsEnabled: false,
      universeDomain: 'googleapis.com',
    });
  });

  it('unwraps the SDK read tuple and normalises the row shape', async () => {
    const log = newLog();
    const client = adaptBigtableSdkModule(
      fakeModule(log, [
        {
          id: 'u1',
          data: { cf: { name: [{ value: 'ada', timestamp: '9' }, { value: 'old' }] } },
        },
      ]),
      { projectId: 'p' },
    );
    const rows = await client
      .instance('i')
      .table('t')
      .readRows({ keys: ['u1'] });
    // The SDK's per-cell timestamp is DROPPED: cell versioning has no
    // counterpart in the portable contract, so carrying it would be a value
    // nothing reads.
    expect(rows).toEqual([
      {
        key: 'u1',
        data: { cf: { name: [{ value: 'ada' }, { value: 'old' }] } },
      },
    ]);
  });

  it('decodes a byte-valued cell a foreign writer stored', async () => {
    const log = newLog();
    const client = adaptBigtableSdkModule(
      fakeModule(log, [
        {
          id: 'u1',
          data: {
            cf: {
              raw: [{ value: new TextEncoder().encode('bytes') }],
              odd: [{ value: 7, timestamp: 5 }],
              none: [{ value: null }],
              bad: ['not-a-cell'],
            },
          },
        },
      ]),
      { projectId: 'p' },
    );
    const rows = await client.instance('i').table('t').readRows({});
    expect(rows[0].data.cf.raw[0].value).toBe('bytes');
    expect(rows[0].data.cf.odd[0].value).toBe('7');
    expect(rows[0].data.cf.none[0].value).toBe('');
    expect(rows[0].data.cf.bad[0].value).toBe('');
  });

  it('omits an empty key list and an empty range list, which the SDK reads as ALL rows', async () => {
    const log = newLog();
    const client = adaptBigtableSdkModule(fakeModule(log), { projectId: 'p' });
    await client.instance('i').table('t').readRows({ keys: [], ranges: [] });
    expect(log.reads[0]).toEqual({});
  });

  it('translates ranges, limits and every filter shape', async () => {
    const log = newLog();
    const client = adaptBigtableSdkModule(fakeModule(log), { projectId: 'p' });
    const filter: BigtableFilter = {
      chain: [
        { family: 'cf' },
        {
          condition: {
            test: [{ column: ['a'] }, { value: { start: 'x', end: 'x' } }],
            pass: [{ all: true }],
          },
        },
        { condition: { test: [{ value: { strip: true } }] } },
      ],
    };
    await client
      .instance('i')
      .table('t')
      .readRows({
        ranges: [
          { start: { value: 'a', inclusive: true } },
          {
            end: { value: 'z', inclusive: false },
          },
        ],
        filter,
        limit: 4,
      });
    expect(log.reads[0]).toEqual({
      ranges: [
        { start: { value: 'a', inclusive: true } },
        {
          end: { value: 'z', inclusive: false },
        },
      ],
      limit: 4,
      filter: [
        { family: 'cf' },
        {
          condition: {
            test: [{ column: ['a'] }, { value: { start: 'x', end: 'x' } }],
            pass: [{ all: true }],
          },
        },
        { condition: { test: [{ value: { strip: true } }] } },
      ],
    });
  });

  it('forwards both CheckAndMutateRow branches and reports the match flag', async () => {
    const log = newLog();
    const client = adaptBigtableSdkModule(fakeModule(log), { projectId: 'p' });
    const matched = await client
      .instance('i')
      .table('t')
      .row('u1')
      .conditionalMutate([{ all: true }], {
        onMatch: [{ method: 'delete' }, { method: 'insert', data: { cf: { a: '1' } } }],
        onNoMatch: [{ method: 'insert', data: { cf: { a: '2' } } }],
      });
    expect(matched).toBe(true);
    expect(log.branches[0]).toEqual({
      onMatch: [{ method: 'delete' }, { method: 'insert', data: { cf: { a: '1' } } }],
      onNoMatch: [{ method: 'insert', data: { cf: { a: '2' } } }],
    });
  });

  it('omits a branch the caller did not supply', async () => {
    const log = newLog();
    const client = adaptBigtableSdkModule(fakeModule(log), { projectId: 'p' });
    await client
      .instance('i')
      .table('t')
      .row('u1')
      .conditionalMutate([{ all: true }], {});
    expect(log.branches[0]).toEqual({});
  });

  it('closes the native client', async () => {
    const log = newLog();
    await adaptBigtableSdkModule(fakeModule(log), { projectId: 'p' }).close();
    expect(log.closes).toBe(1);
  });
});

it('loads and closes the installed Bigtable SDK without making a remote call', async () => {
  const loader = createLazyBigtableLoader({ projectId: 'test-project' });
  const client = await loader.load();
  expect(client.instance('i').table('t')).toBeDefined();
  await client.close();
});

it('preserves both interleaved filter arms on the SDK read wire', async () => {
  const log = newLog();
  const client = adaptBigtableSdkModule(fakeModule(log), { projectId: 'p' });
  await client
    .instance('i')
    .table('t')
    .readRows({
      filter: { interleave: [[{ all: true }], [{ family: 'cf' }]] },
    });
  expect(log.reads).toEqual([{ filter: { interleave: [[{ all: true }], [{ family: 'cf' }]] } }]);
});

describe('createLazyBigtableLoader — the guarded import (M113d §3.1)', () => {
  it('rejects with OptionalDependencyUnavailableError when the SDK is absent', async () => {
    vi.doMock('@google-cloud/bigtable', () => {
      throw new Error('Cannot find package');
    });
    try {
      let caught: unknown;
      try {
        await createLazyBigtableLoader({ projectId: 'p' }).load();
      } catch (error) {
        caught = error;
      }
      const loadError = caught as Error & { dependency: string; cause: unknown };
      expect(loadError.name).toBe('OptionalDependencyUnavailableError');
      expect(loadError.dependency).toBe('@google-cloud/bigtable');
      expect(loadError.cause).toBeInstanceOf(Error);
    } finally {
      vi.doUnmock('@google-cloud/bigtable');
    }
  });
});
