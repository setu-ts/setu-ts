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
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type {
  BigtableFilter,
  IBigtableClient,
} from '../../src/adapters/bigtable/bigtable-client-types.ts';
import {
  adaptBigtableSdkModule,
  type BigtableClientConfiguration,
  type BigtableSdkModule,
  createInjectedBigtableLoader,
  createLazyBigtableLoader,
} from '../../src/adapters/bigtable/bigtable-client.ts';

/** Everything the fake SDK module saw. */
interface SdkLog {
  configuration?: BigtableClientConfiguration;
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
      constructor(configuration: BigtableClientConfiguration) {
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
                return Promise.resolve(
                  [rows as { id: string }[]] as [readonly { id: string }[], ...unknown[]],
                );
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

describe('adaptBigtableSdkModule', () => {
  it('passes the configuration to the native constructor', () => {
    const log = newLog();
    adaptBigtableSdkModule(fakeModule(log), { projectId: 'p', apiEndpoint: '127.0.0.1:8086' });
    expect(log.configuration).toEqual({ projectId: 'p', apiEndpoint: '127.0.0.1:8086' });
  });

  it('unwraps the SDK read tuple and normalises the row shape', async () => {
    const log = newLog();
    const client = adaptBigtableSdkModule(
      fakeModule(log, [{
        id: 'u1',
        data: { cf: { name: [{ value: 'ada', timestamp: '9' }, { value: 'old' }] } },
      }]),
      { projectId: 'p' },
    );
    const rows = await client.instance('i').table('t').readRows({ keys: ['u1'] });
    // The SDK's per-cell timestamp is DROPPED: cell versioning has no
    // counterpart in the portable contract, so carrying it would be a value
    // nothing reads.
    expect(rows).toEqual([{
      key: 'u1',
      data: { cf: { name: [{ value: 'ada' }, { value: 'old' }] } },
    }]);
  });

  it('decodes a byte-valued cell a foreign writer stored', async () => {
    const log = newLog();
    const client = adaptBigtableSdkModule(
      fakeModule(log, [{
        id: 'u1',
        data: {
          cf: {
            raw: [{ value: new TextEncoder().encode('bytes') }],
            odd: [{ value: 7, timestamp: 5 }],
            none: [{ value: null }],
            bad: ['not-a-cell'],
          },
        },
      }]),
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
    await client.instance('i').table('t').readRows({
      ranges: [{ start: { value: 'a', inclusive: true } }, {
        end: { value: 'z', inclusive: false },
      }],
      filter,
      limit: 4,
    });
    expect(log.reads[0]).toEqual({
      ranges: [{ start: { value: 'a', inclusive: true } }, {
        end: { value: 'z', inclusive: false },
      }],
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
    const matched = await client.instance('i').table('t').row('u1').conditionalMutate(
      [{ all: true }],
      {
        onMatch: [{ method: 'delete' }, { method: 'insert', data: { cf: { a: '1' } } }],
        onNoMatch: [{ method: 'insert', data: { cf: { a: '2' } } }],
      },
    );
    expect(matched).toBe(true);
    expect(log.branches[0]).toEqual({
      onMatch: [{ method: 'delete' }, { method: 'insert', data: { cf: { a: '1' } } }],
      onNoMatch: [{ method: 'insert', data: { cf: { a: '2' } } }],
    });
  });

  it('omits a branch the caller did not supply', async () => {
    const log = newLog();
    const client = adaptBigtableSdkModule(fakeModule(log), { projectId: 'p' });
    await client.instance('i').table('t').row('u1').conditionalMutate([{ all: true }], {});
    expect(log.branches[0]).toEqual({});
  });

  it('closes the native client', async () => {
    const log = newLog();
    await adaptBigtableSdkModule(fakeModule(log), { projectId: 'p' }).close();
    expect(log.closes).toBe(1);
  });
});
