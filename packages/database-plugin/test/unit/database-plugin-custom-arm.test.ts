/**
 * The `type: 'custom'` arm that M52c added to `DatabasePlugin`.
 *
 * Before it, `createAdapter` was a closed switch over three built-in types
 * whose `default:` fell through to the memory adapter, so a backend outside
 * this package could not be registered at all.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createApplication } from '@hono-enterprise/kernel';
import { RuntimePlugin } from '@hono-enterprise/runtime';
import { CAPABILITIES } from '@hono-enterprise/common';
import type {
  IAdapterTransaction,
  IDatabaseAdapter,
  IDataSource,
  ILogger,
  IPlugin,
  LogLevel,
  LogMetadata,
} from '@hono-enterprise/common';

import { DatabasePlugin } from '../../src/index.ts';
import type { IDatabaseService } from '../../src/index.ts';

/** A backend that records what the plugin and service asked of it. */
class RecordingAdapter implements IDatabaseAdapter {
  connects = 0;
  disconnects = 0;
  readonly rawQueries: { sql: string; params?: unknown[] }[] = [];
  readonly entities: string[] = [];
  #ready = false;

  connect(): Promise<void> {
    this.connects += 1;
    this.#ready = true;
    return Promise.resolve();
  }

  disconnect(): Promise<void> {
    this.disconnects += 1;
    this.#ready = false;
    return Promise.resolve();
  }

  isReady(): boolean {
    return this.#ready;
  }

  createDataSource(entity: string): IDataSource {
    this.entities.push(entity);
    return emptySource();
  }

  beginTransaction(): Promise<IAdapterTransaction> {
    return Promise.resolve({
      createDataSource: () => emptySource(),
      commit: () => Promise.resolve(),
      rollback: () => Promise.resolve(),
    });
  }

  rawQuery<T>(sql: string, params?: unknown[]): Promise<T[]> {
    this.rawQueries.push(params === undefined ? { sql } : { sql, params });
    return Promise.resolve([]);
  }
}

function emptySource(): IDataSource {
  return {
    findAll: () => Promise.resolve([]),
    findById: () => Promise.resolve(null),
    create: (data) => Promise.resolve({ ...data } as Record<string, unknown>),
    update: (_id, data) => Promise.resolve({ ...data } as Record<string, unknown>),
    delete: () => Promise.resolve(true),
    count: () => Promise.resolve(0),
  };
}

/** Captures debug records so `logQueries` can be observed. */
class CapturingLogger implements ILogger {
  readonly debugs: { message: string; meta?: LogMetadata }[] = [];
  readonly level: LogLevel = 'debug';
  fatal(): void {}
  error(): void {}
  warn(): void {}
  info(): void {}
  debug(message: string, meta?: LogMetadata): void {
    this.debugs.push(meta === undefined ? { message } : { message, meta });
  }
  trace(): void {}
  child(): ILogger {
    return this;
  }
}

/** Publishes a logger under `CAPABILITIES.LOGGER`, as `LoggerPlugin` would. */
function loggerPlugin(logger: ILogger): IPlugin {
  return {
    name: 'test-logger',
    version: '0.0.0',
    provides: [CAPABILITIES.LOGGER],
    register(ctx): void {
      ctx.services.register(CAPABILITIES.LOGGER, logger);
    },
  };
}

describe('DatabasePlugin — the custom arm', () => {
  it('uses the supplied adapter verbatim and connects it during register', async () => {
    const adapter = new RecordingAdapter();
    const app = createApplication({
      plugins: [RuntimePlugin(), DatabasePlugin({ type: 'custom', adapter })],
    });

    await app.start();

    expect(adapter.connects).toBe(1);
    expect(adapter.isReady()).toBe(true);
    await app.stop();
    expect(adapter.disconnects).toBe(1);
  });

  it('routes repository access to the custom adapter own data sources', async () => {
    const adapter = new RecordingAdapter();
    const app = createApplication({
      plugins: [RuntimePlugin(), DatabasePlugin({ type: 'custom', adapter })],
    });
    await app.start();

    const db = app.services.get<IDatabaseService>(CAPABILITIES.DATABASE);
    await db.getRepository('Order').findAll();

    expect(adapter.entities).toEqual(['Order']);
    await app.stop();
  });

  it('reaches rawQuery through the service query() method', async () => {
    const adapter = new RecordingAdapter();
    const app = createApplication({
      plugins: [RuntimePlugin(), DatabasePlugin({ type: 'custom', adapter })],
    });
    await app.start();

    const db = app.services.get<IDatabaseService>(CAPABILITIES.DATABASE);
    await db.query('SELECT 1', [7]);

    expect(adapter.rawQueries).toEqual([{ sql: 'SELECT 1', params: [7] }]);
    await app.stop();
  });

  it('registers under database.<name> for a named connection', async () => {
    const adapter = new RecordingAdapter();
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        DatabasePlugin({ type: 'custom', adapter, name: 'analytics' }),
      ],
    });
    await app.start();

    expect(app.services.has('database.analytics')).toBe(true);
    expect(app.services.has(CAPABILITIES.DATABASE)).toBe(false);
    await app.stop();
  });

  it('honors logQueries for a custom adapter, through the ONE service-level wrapper', async () => {
    const logger = new CapturingLogger();
    const adapter = new RecordingAdapter();
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        loggerPlugin(logger),
        DatabasePlugin({ type: 'custom', adapter, options: { logQueries: true } }),
      ],
    });
    await app.start();

    const db = app.services.get<IDatabaseService>(CAPABILITIES.DATABASE);
    await db.getRepository('Order').count();

    expect(logger.debugs.map((d) => d.message)).toContain('[Order] count');
    await app.stop();
  });

  it('leaves the three built-in arms working', async () => {
    const app = createApplication({
      plugins: [RuntimePlugin(), DatabasePlugin({ type: 'memory' })],
    });
    await app.start();

    const db = app.services.get<IDatabaseService>(CAPABILITIES.DATABASE);
    const users = db.getRepository<{ id: string; name: string }>('User');
    const created = await users.create({ name: 'ada' });

    expect(await users.findById(created.id)).toMatchObject({ name: 'ada' });
    await app.stop();
  });

  it('still defaults to the memory adapter when no type is given', async () => {
    const app = createApplication({ plugins: [RuntimePlugin(), DatabasePlugin()] });
    await app.start();

    const db = app.services.get<IDatabaseService>(CAPABILITIES.DATABASE);
    // The memory adapter is the only one that refuses raw SQL by type. It
    // refuses synchronously — see the note on `DatabaseService.query`.
    expect(() => db.query('SELECT 1')).toThrow(/does not support raw SQL/);
    await app.stop();
  });
});
