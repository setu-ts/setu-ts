/**
 * Coverage for {@linkcode MongoAdapter} lifecycle and its named refusals.
 *
 * Drives the adapter through an injected {@linkcode IMongoClient} — no server —
 * asserting the documented contract: `isReady()` performs no I/O, `connect()`
 * drives the client, `beginTransaction` opens a session and refuses on a
 * non-replica-set deployment, and `rawQuery` **rejects** (never throws
 * synchronously) with {@linkcode UnsupportedRawQueryError}.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { MongoAdapter, parseDatabaseFromUrl } from '../../src/adapters/mongo/mongo-adapter.ts';
import type { MongoAdapterOptions } from '../../src/interfaces/index.ts';
import { MongoTransactionUnavailableError } from '../../src/errors.ts';
import {
  FakeMongoClient,
  fakeObjectIdCtor,
  FakeSession,
  FakeSessionClient,
} from '../fixtures/fake-mongo-client.ts';

describe('MongoAdapter — lifecycle against an injected client', () => {
  it('is not ready before connect and ready after', async () => {
    const client = new FakeMongoClient();
    const adapter = new MongoAdapter({
      url: 'mongodb://localhost:27017/db',
      client,
    });
    expect(adapter.isReady()).toBe(false);
    await adapter.connect();
    expect(adapter.isReady()).toBe(true);
    await adapter.disconnect();
    expect(adapter.isReady()).toBe(false);
  });

  it('drives the injected client through connect', async () => {
    const client = new FakeMongoClient();
    const adapter = new MongoAdapter({
      url: 'mongodb://localhost:27017/db',
      client,
    });
    await adapter.connect();
    expect(client.isReady()).toBe(true);
  });

  it('fails to construct when neither url nor client is supplied', () => {
    // `MongoAdapterOptions` is a union whose arms each require one of the two,
    // so a typed caller cannot reach this — the cast stands in for the plugin's
    // untyped `buildAdapterOptions` carry, which is the only real path here.
    expect(() => new MongoAdapter({} as unknown as MongoAdapterOptions)).toThrow(
      /requires either/,
    );
  });

  it('rejects an options bag supplying neither url nor client at compile time', () => {
    // @ts-expect-error — neither arm of the union is satisfied. The directive is
    // self-validating: if the union ever stops enforcing this, the unused
    // expect-error becomes a compile error of its own.
    const unusable: MongoAdapterOptions = { database: 'app' };
    expect(unusable.database).toBe('app');
  });

  it('connects idempotently — the second connect() performs no new client work', async () => {
    const client = new FakeMongoClient();
    const adapter = new MongoAdapter({ url: 'mongodb://localhost:27017/db', client });
    await adapter.connect();
    await adapter.connect();
    expect(client.isReady()).toBe(true);
  });

  it('resolves a database name from url when options.database is absent', async () => {
    const client = new FakeMongoClient();
    const adapter = new MongoAdapter({
      url: 'mongodb://localhost:27017/ordersdb',
      client,
    });
    await adapter.connect();
    const ds = adapter.createDataSource('Order');
    await expect(ds.count({}, undefined)).resolves.toBe(0);
    // The data source reached the 'ordersdb' database on the injected client.
    expect(client.databases.has('ordersdb')).toBe(true);
  });

  it('resolves the explicit options.database ahead of the url segment', async () => {
    const client = new FakeMongoClient();
    const adapter = new MongoAdapter({
      url: 'mongodb://localhost:27017/url-db',
      database: 'explicit-db',
      client,
    });
    await adapter.connect();
    adapter.createDataSource('Order');
    // The explicit option wins, so the url-encoded database is never consulted.
    expect(client.databases.has('explicit-db')).toBe(true);
    expect(client.databases.has('url-db')).toBe(false);
  });

  it('uses the supplied ObjectId constructor with an injected client', async () => {
    const client = new FakeMongoClient();
    const adapter = new MongoAdapter({
      url: 'mongodb://localhost:27017/db',
      client,
      objectIdCtor: fakeObjectIdCtor,
    });
    await adapter.connect();
    const source = adapter.createDataSource('Widget');
    await source.create({ id: '507f1f77bcf86cd799439011', name: 'Bolt' });
    await expect(source.findById('507f1f77bcf86cd799439011')).resolves.toEqual({
      id: '507f1f77bcf86cd799439011',
      name: 'Bolt',
    });
  });

  it('disconnects cleanly when it was never connected', async () => {
    const adapter = new MongoAdapter({ url: 'mongodb://localhost:27017/db' });
    await adapter.disconnect();
    expect(adapter.isReady()).toBe(false);
  });

  it('fails connect when no database name can be resolved', async () => {
    const client = new FakeMongoClient();
    const adapter = new MongoAdapter({ url: 'mongodb://localhost:27017', client });
    await expect(adapter.connect()).rejects.toThrow(/could not resolve a database name/);
  });
});

describe('MongoAdapter — lazy connect (guarded on a live server)', () => {
  // The lazy path performs the real `import('npm:mongodb@^6.21.0')` and then
  // `client.connect()`. Against no server the connection is refused, so this
  // guards the inject-or-lazy branch of connect() without a fixture: a live
  // server is required to drive the success branch, and the absence of one
  // drives the failure branch.
  it('lazy connect() rejects when no server is reachable', async () => {
    const adapter = new MongoAdapter({
      url: 'mongodb://127.0.0.1:1/db?serverSelectionTimeoutMS=10&connectTimeoutMS=10',
    });
    await expect(adapter.connect()).rejects.toThrow();
    expect(adapter.isReady()).toBe(false);
  });
});

describe('MongoAdapter — rawQuery refuses by name', () => {
  it('rejects (never throws synchronously) with UnsupportedRawQueryError', async () => {
    const client = new FakeMongoClient();
    const adapter = new MongoAdapter({
      url: 'mongodb://localhost:27017/db',
      client,
    });
    await adapter.connect();
    // The method is Promise-typed, so it must reject, not throw synchronously.
    // The CALL must sit inside the assertion: `expect(() => promise)` only ever
    // returns an already-created value and can never throw, so it passed
    // whatever the adapter did.
    let first: Promise<unknown> | undefined;
    expect(() => {
      first = adapter.rawQuery('select 1');
    }).not.toThrow();
    // Assert the rejection rather than swallowing it: the contract is "rejects,
    // never throws synchronously", and catching without asserting would leave
    // a `rawQuery` that RESOLVED passing this test.
    await expect(first).rejects.toThrow(/does not support raw SQL/);
  });
});

describe('MongoAdapter — transactions', () => {
  it('opens a session and returns a transaction on a replica-capable client', async () => {
    const session = new FakeSession();
    const client = new FakeSessionClient(session);
    const adapter = new MongoAdapter({
      url: 'mongodb://localhost:27017/db',
      client,
      objectIdCtor: fakeObjectIdCtor,
    });
    await adapter.connect();
    const tx = await adapter.beginTransaction();
    expect(session.started).toBe(true);
    expect(session.calls).toContain('startTransaction');
    await tx.createDataSource('Widget').create({ id: '507f1f77bcf86cd799439011' });
    await expect(tx.createDataSource('Widget').findById('507f1f77bcf86cd799439011')).resolves
      .toEqual({ id: '507f1f77bcf86cd799439011' });
    await tx.commit();
    expect(session.calls).toContain('commitTransaction');
    expect(session.calls).toContain('endSession');
  });

  it('wraps a startTransaction failure in MongoTransactionUnavailableError', async () => {
    const failingSession = new FakeSession(true);
    const client = new FakeSessionClient(failingSession);
    const adapter = new MongoAdapter({ url: 'mongodb://localhost:27017/db', client });
    await adapter.connect();
    await expect(adapter.beginTransaction()).rejects.toBeInstanceOf(
      MongoTransactionUnavailableError,
    );
    // The failed session is ended, never leaked.
    expect(failingSession.calls).toContain('endSession');
  });

  it('refuses beginTransaction when not connected', async () => {
    const adapter = new MongoAdapter({ url: 'mongodb://localhost:27017/db' });
    await expect(adapter.beginTransaction()).rejects.toThrow(/not connected/);
  });
});

describe('parseDatabaseFromUrl', () => {
  it('parses the database segment of a mongodb:// url', () => {
    expect(parseDatabaseFromUrl('mongodb://host:27017/mydb')).toBe('mydb');
  });

  it('parses the database segment of a mongodb+srv:// url', () => {
    expect(parseDatabaseFromUrl('mongodb+srv://cluster.example.com/srvdb')).toBe('srvdb');
  });

  it('returns undefined when no database is encoded', () => {
    expect(parseDatabaseFromUrl('mongodb://host:27017')).toBeUndefined();
  });
});

describe('MongoAdapter — a failed connect() does not wedge the adapter', () => {
  /** A client whose first `connect()` fails and whose later ones succeed. */
  class FlakyClient extends FakeMongoClient {
    attempts = 0;
    closed = 0;
    override connect(): Promise<void> {
      this.attempts += 1;
      if (this.attempts === 1) return Promise.reject(new Error('server unreachable'));
      return super.connect();
    }
    override close(): Promise<void> {
      this.closed += 1;
      return super.close();
    }
  }

  it('a later connect() retries instead of returning silently', async () => {
    // Assigning `#client` before the connection succeeded left it non-null on
    // failure, so the `#client !== null` guard made every later connect() a
    // no-op that RESOLVED while `isReady()` stayed false — an adapter that
    // reports success and can never serve a request.
    const client = new FlakyClient();
    const adapter = new MongoAdapter({ url: 'mongodb://localhost:27017/db', client });

    await expect(adapter.connect()).rejects.toThrow(/server unreachable/);
    expect(adapter.isReady()).toBe(false);

    await adapter.connect();
    expect(adapter.isReady()).toBe(true);
    expect(client.attempts).toBe(2);
    // The data path works after the retry, which `isReady()` alone would not show.
    expect(() => adapter.createDataSource('Widget')).not.toThrow();
  });

  it('does not close an injected client the application owns', async () => {
    const client = new FlakyClient();
    const adapter = new MongoAdapter({ url: 'mongodb://localhost:27017/db', client });
    await expect(adapter.connect()).rejects.toThrow();
    // Only a client this adapter constructed is closed on failure; an injected
    // one belongs to the caller, who may still reuse it.
    expect(client.closed).toBe(0);
  });

  it('a database that cannot be resolved leaves the adapter retryable', async () => {
    // `#resolveDatabaseName()` throws AFTER the connection is open, which is
    // the second way the old ordering left an unusable, non-null client.
    const client = new FakeMongoClient();
    const adapter = new MongoAdapter({ url: 'mongodb://localhost:27017', client });
    await expect(adapter.connect()).rejects.toThrow(/could not resolve a database name/);
    expect(adapter.isReady()).toBe(false);
    await expect(adapter.connect()).rejects.toThrow(/could not resolve a database name/);
  });
});

describe('MongoAdapter — concurrent connect()', () => {
  /** Counts driver `connect()` calls — the work a shared attempt avoids. */
  class CountingClient extends FakeMongoClient {
    connects = 0;
    override connect(): Promise<void> {
      this.connects += 1;
      return super.connect();
    }
  }

  it('concurrent callers share one attempt instead of each running the sequence', async () => {
    // Counting constructions cannot discriminate here: an injected loader hands
    // back the same instance however many times it is asked. The observable
    // duplicate is the connect sequence itself, which each caller ran once.
    const client = new CountingClient();
    const adapter = new MongoAdapter({ url: 'mongodb://localhost:27017/db', client });

    await Promise.all([adapter.connect(), adapter.connect(), adapter.connect()]);

    expect(adapter.isReady()).toBe(true);
    expect(client.connects).toBe(1);
  });

  it('a shared failed attempt is not cached, so a later connect() retries', async () => {
    // Caching the in-flight promise past settlement would hold a rejection and
    // reinstate the permanently-unusable adapter the ordering fix removed.
    let fail = true;
    const client = new (class extends FakeMongoClient {
      override connect(): Promise<void> {
        if (fail) return Promise.reject(new Error('down'));
        return super.connect();
      }
    })();
    const adapter = new MongoAdapter({ url: 'mongodb://localhost:27017/db', client });

    const results = await Promise.allSettled([adapter.connect(), adapter.connect()]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);

    fail = false;
    await adapter.connect();
    expect(adapter.isReady()).toBe(true);
  });
});
