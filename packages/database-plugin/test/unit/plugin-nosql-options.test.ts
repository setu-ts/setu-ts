/**
 * The NoSQL arms' call bound, readiness table and SDK constructor options
 * cross the plugin boundary.
 *
 * Each case registers `DatabasePlugin({ type, options })` on the LAZY arm with
 * the SDK import served by a recording module, so a value is proven to reach
 * the adapter by what the SDK then sees — `buildAdapterOptions` dropping a key
 * leaves the adapter on its default, and the recording shows it. The
 * Bigtable rows also cover the plugin's `BIGTABLE_EMULATOR_HOST` read through
 * `ctx.runtime.env`.
 *
 * @module
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CAPABILITIES, type IPluginContext } from '@setu-ts/common';
import { DatabasePlugin } from '../../src/plugin/database-plugin.ts';
import { DatabaseTimeoutError } from '../../src/index.ts';
import type { DatabasePluginOptions, IDatabaseService } from '../../src/interfaces/index.ts';

/** The registered service and health indicator of one plugin registration. */
interface Registered {
  readonly service: IDatabaseService;
  readonly indicator: () => Promise<{ status: string; data?: Record<string, unknown> }>;
  readonly close: () => Promise<void>;
}

async function register(
  options: DatabasePluginOptions,
  env: Record<string, string> = {},
): Promise<Registered> {
  const services = new Map<string, unknown>();
  let indicator: Registered['indicator'] | undefined;
  const closers: (() => Promise<void>)[] = [];
  let clock = 0;
  const ctx = {
    services: {
      has: () => false,
      get: () => undefined,
      register: (token: string, service: unknown) => {
        services.set(token, service);
      },
    },
    health: {
      register: (_name: string, fn: Registered['indicator']) => {
        indicator = fn;
      },
    },
    lifecycle: {
      onClose: (fn: () => Promise<void>) => {
        closers.push(fn);
      },
    },
    runtime: {
      env,
      hrtime: () => (clock += 1000),
      setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
      clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    },
  } as unknown as IPluginContext;
  await DatabasePlugin(options).register(ctx);
  return {
    service: services.get(CAPABILITIES.DATABASE) as IDatabaseService,
    indicator: indicator!,
    close: async () => {
      for (const close of closers) await close();
    },
  };
}

/** A promise that settles only when the call's abort signal fires. */
function untilAborted(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(signal.reason));
  });
}

afterEach(() => {
  vi.doUnmock('@aws-sdk/client-dynamodb');
  vi.doUnmock('@azure/cosmos');
  vi.doUnmock('@google-cloud/bigtable');
});

// --- DynamoDB -------------------------------------------------------------

interface DynamoRecord {
  configurations: Record<string, unknown>[];
  sends: { command: string; input: Record<string, unknown>; signal: AbortSignal | undefined }[];
  hang: boolean;
}

function mockDynamoSdk(): DynamoRecord {
  const record: DynamoRecord = { configurations: [], sends: [], hang: false };
  const command = (name: string) =>
    class {
      static readonly commandName = name;
      constructor(readonly input: Record<string, unknown>) {}
    };
  vi.doMock('@aws-sdk/client-dynamodb', () => ({
    DynamoDBClient: class {
      constructor(configuration: Record<string, unknown>) {
        record.configurations.push(configuration);
      }
      send(
        sent: { input: Record<string, unknown>; constructor: { commandName: string } },
        options?: { abortSignal?: AbortSignal },
      ): Promise<unknown> {
        record.sends.push({
          command: sent.constructor.commandName,
          input: sent.input,
          signal: options?.abortSignal,
        });
        return record.hang ? untilAborted(options?.abortSignal) : Promise.resolve({});
      }
      destroy(): void {}
    },
    QueryCommand: command('Query'),
    ScanCommand: command('Scan'),
    GetItemCommand: command('GetItem'),
    PutItemCommand: command('PutItem'),
    UpdateItemCommand: command('UpdateItem'),
    DeleteItemCommand: command('DeleteItem'),
    TransactWriteItemsCommand: command('TransactWriteItems'),
  }));
  return record;
}

describe("DatabasePlugin 'dynamodb' arm options", () => {
  it('carries clientOptions to the SDK constructor', async () => {
    const record = mockDynamoSdk();
    const app = await register({
      type: 'dynamodb',
      options: {
        region: 'us-east-1',
        endpoint: 'http://127.0.0.1:8000',
        clientOptions: { maxAttempts: 1, region: 'eu-west-1' },
      },
    });
    await app.close();
    expect(record.configurations).toEqual([
      { region: 'us-east-1', endpoint: 'http://127.0.0.1:8000', maxAttempts: 1 },
    ]);
  });

  it('carries requestTimeoutMs: a hanging call ends at the configured bound', async () => {
    const record = mockDynamoSdk();
    const app = await register({
      type: 'dynamodb',
      options: {
        region: 'us-east-1',
        requestTimeoutMs: 25,
        entities: { Row: { partitionKey: 'id' } },
      },
    });
    try {
      record.hang = true;
      await expect(app.service.getRepository('Row').findById('a')).rejects.toBeInstanceOf(
        DatabaseTimeoutError,
      );
    } finally {
      await app.close();
    }
  });

  it('carries requestTimeoutMs: 0 so no call carries a signal', async () => {
    const record = mockDynamoSdk();
    const app = await register({
      type: 'dynamodb',
      options: {
        region: 'us-east-1',
        requestTimeoutMs: 0,
        entities: { Row: { partitionKey: 'id' } },
      },
    });
    try {
      await app.service.getRepository('Row').findById('a');
      expect(record.sends.length).toBeGreaterThan(0);
      expect(record.sends.every((send) => send.signal === undefined)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('carries an out-of-range requestTimeoutMs to the adapter, which refuses it', async () => {
    mockDynamoSdk();
    await expect(
      register({ type: 'dynamodb', options: { region: 'us-east-1', requestTimeoutMs: -1 } }),
    ).rejects.toBeInstanceOf(RangeError);
  });

  it('carries readinessEntity: the probe reads that entity’s table', async () => {
    const record = mockDynamoSdk();
    const app = await register({
      type: 'dynamodb',
      options: {
        region: 'us-east-1',
        readinessEntity: 'Audit',
        entities: {
          Order: { table: 'orders', partitionKey: 'id' },
          Audit: { table: 'audit', partitionKey: 'entryId' },
        },
      },
    });
    try {
      const health = await app.indicator();
      expect(health.data?.['reachable']).toBe(true);
      const probe = record.sends.filter((send) => send.command === 'GetItem');
      expect(probe.map((send) => send.input['TableName'])).toEqual(['audit']);
      expect(probe[0]?.input['Key']).toEqual({ entryId: { S: '__setu_readiness__' } });
    } finally {
      await app.close();
    }
  });
});

// --- Cosmos ---------------------------------------------------------------

interface CosmosRecord {
  configurations: Record<string, unknown>[];
  databaseReads: (AbortSignal | undefined)[];
  hangItems: boolean;
}

function mockCosmosSdk(): CosmosRecord {
  const record: CosmosRecord = { configurations: [], databaseReads: [], hangItems: false };
  vi.doMock('@azure/cosmos', () => ({
    CosmosClient: class {
      constructor(configuration: Record<string, unknown>) {
        record.configurations.push(configuration);
      }
      database(): unknown {
        return {
          read: (options?: { abortSignal?: AbortSignal }) => {
            record.databaseReads.push(options?.abortSignal);
            return Promise.resolve({ statusCode: 200 });
          },
          container: () => ({
            read: () =>
              Promise.resolve({ statusCode: 200, resource: { partitionKey: { paths: ['/id'] } } }),
            item: () => ({
              read: (options?: { abortSignal?: AbortSignal }) =>
                record.hangItems
                  ? untilAborted(options?.abortSignal)
                  : Promise.resolve({ statusCode: 404 }),
            }),
          }),
        };
      }
    },
  }));
  return record;
}

const COSMOS = { endpoint: 'https://acct.documents.azure.com:443/', key: 'k', database: 'app' };

describe("DatabasePlugin 'cosmos' arm options", () => {
  it('carries clientOptions to the SDK constructor', async () => {
    const record = mockCosmosSdk();
    const app = await register({
      type: 'cosmos',
      options: { ...COSMOS, clientOptions: { userAgentSuffix: 'setu', key: 'ignored' } },
    });
    await app.close();
    expect(record.configurations).toEqual([
      { endpoint: COSMOS.endpoint, key: 'k', userAgentSuffix: 'setu' },
    ]);
  });

  it('carries requestTimeoutMs: a hanging call ends at the configured bound', async () => {
    const record = mockCosmosSdk();
    const app = await register({ type: 'cosmos', options: { ...COSMOS, requestTimeoutMs: 25 } });
    try {
      record.hangItems = true;
      await expect(app.service.getRepository('Row').findById('a')).rejects.toBeInstanceOf(
        DatabaseTimeoutError,
      );
    } finally {
      await app.close();
    }
  });

  it('carries requestTimeoutMs: 0 so the connect read carries no signal', async () => {
    const record = mockCosmosSdk();
    const app = await register({ type: 'cosmos', options: { ...COSMOS, requestTimeoutMs: 0 } });
    await app.close();
    expect(record.databaseReads).toEqual([undefined]);
  });
});

// --- Bigtable -------------------------------------------------------------

interface BigtableRecord {
  configurations: Record<string, unknown>[];
  reads: { table: string; options: Record<string, unknown> }[];
}

function mockBigtableSdk(): BigtableRecord {
  const record: BigtableRecord = { configurations: [], reads: [] };
  vi.doMock('@google-cloud/bigtable', () => ({
    Bigtable: class {
      constructor(configuration: Record<string, unknown>) {
        record.configurations.push(configuration);
      }
      instance() {
        return {
          table: (table: string) => ({
            getRows: (options: Record<string, unknown>) => {
              record.reads.push({ table, options });
              return Promise.resolve([[]]);
            },
            row: () => ({ filter: () => Promise.resolve([true]) }),
          }),
        };
      }
      close() {
        return Promise.resolve();
      }
    },
  }));
  return record;
}

describe("DatabasePlugin 'bigtable' arm options", () => {
  it('carries clientOptions to the SDK constructor', async () => {
    const record = mockBigtableSdk();
    const app = await register({
      type: 'bigtable',
      options: {
        projectId: 'p',
        instance: 'i',
        clientOptions: { projectId: 'ignored', universeDomain: 'example.test' },
      },
    });
    await app.close();
    expect(record.configurations).toEqual([{ projectId: 'p', universeDomain: 'example.test' }]);
  });

  it('carries requestTimeoutMs and readinessEntity to the warm-up and the probe', async () => {
    const record = mockBigtableSdk();
    const app = await register({
      type: 'bigtable',
      options: {
        projectId: 'p',
        instance: 'i',
        requestTimeoutMs: 750,
        readinessEntity: 'Audit',
        tables: { Order: { table: 'orders' }, Audit: { table: 'audit' } },
      },
    });
    try {
      expect(await app.indicator()).toMatchObject({ data: { reachable: true } });
      // The warm-up at connect, then the readiness probe: both on the readiness
      // entity's table, both bounded by min(requestTimeoutMs, 2000).
      expect(record.reads.map((read) => read.table)).toEqual(['audit', 'audit']);
      expect(record.reads.map((read) => read.options['gaxOptions'])).toEqual([
        { timeout: 750 },
        { timeout: 750 },
      ]);
      await app.service.getRepository('Order').findById('a');
      expect(record.reads[2]).toMatchObject({
        table: 'orders',
        options: { gaxOptions: { timeout: 750 } },
      });
    } finally {
      await app.close();
    }
  });

  it('carries requestTimeoutMs: 0 so a data read carries no gax deadline', async () => {
    const record = mockBigtableSdk();
    const app = await register({
      type: 'bigtable',
      options: { projectId: 'p', instance: 'i', requestTimeoutMs: 0, tables: { Order: {} } },
    });
    try {
      record.reads.length = 0;
      await app.service.getRepository('Order').findById('a');
      expect(record.reads).toHaveLength(1);
      expect(record.reads[0]?.options).not.toHaveProperty('gaxOptions');
    } finally {
      await app.close();
    }
  });

  const metrics: readonly {
    readonly name: string;
    readonly env: Record<string, string>;
    readonly metricsEnabled: false | undefined;
  }[] = [
    {
      name: 'BIGTABLE_EMULATOR_HOST set',
      env: { BIGTABLE_EMULATOR_HOST: '127.0.0.1:8086' },
      metricsEnabled: false,
    },
    {
      name: 'BIGTABLE_EMULATOR_HOST empty',
      env: { BIGTABLE_EMULATOR_HOST: '' },
      metricsEnabled: undefined,
    },
    { name: 'no emulator variable', env: {}, metricsEnabled: undefined },
  ];
  for (const row of metrics) {
    it(`reads the environment through ctx.runtime.env: ${row.name}`, async () => {
      const record = mockBigtableSdk();
      const app = await register(
        { type: 'bigtable', options: { projectId: 'p', instance: 'i' } },
        row.env,
      );
      await app.close();
      expect(record.configurations).toHaveLength(1);
      expect(record.configurations[0]?.['metricsEnabled']).toBe(row.metricsEnabled);
      expect('emulatorFromEnvironment' in record.configurations[0]!).toBe(false);
    });
  }

  it('lets clientOptions.metricsEnabled win over the emulator default', async () => {
    const record = mockBigtableSdk();
    const app = await register(
      {
        type: 'bigtable',
        options: { projectId: 'p', instance: 'i', clientOptions: { metricsEnabled: true } },
      },
      { BIGTABLE_EMULATOR_HOST: '127.0.0.1:8086' },
    );
    await app.close();
    expect(record.configurations[0]?.['metricsEnabled']).toBe(true);
  });

  it('ignores BIGTABLE_EMULATOR_HOST on another arm', async () => {
    const record = mockDynamoSdk();
    const app = await register(
      { type: 'dynamodb', options: { region: 'us-east-1' } },
      { BIGTABLE_EMULATOR_HOST: '127.0.0.1:8086' },
    );
    await app.close();
    expect(record.configurations).toEqual([{ region: 'us-east-1' }]);
  });
});
