/** Tier C at real backend surfaces, including the §10 security obligations. @module */
import { describe, it } from '@std/testing/bdd';
import { afterAll, beforeAll } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { ILogger, IPlugin } from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';
import { BigtableAdapter, TransactionalStoreUnavailableError } from '@setu-ts/database-plugin';
import type { IUnitOfWork } from '@setu-ts/database-plugin';
import { errorHandler } from '@setu-ts/exceptions';
import { IdempotencyWithinError } from '../../src/index.ts';
import {
  deferred,
  dynamoHarness,
  mongoHarness,
  postgresHarness,
  servicesOf,
  withinApp,
  withinOptions,
  writeBusiness,
} from '../fixtures/within-backends.ts';
import type { BackendHarness } from '../fixtures/within-backends.ts';

const postgresUrl = Deno.env.get('OUTBOX_POSTGRES_URL');
const mongoRsUri = Deno.env.get('MONGODB_RS_URI');
const mongoUri = Deno.env.get('MONGODB_URI');
const dynamoEndpoint = Deno.env.get('DYNAMODB_ENDPOINT_URL');
const bigtableEndpoint = Deno.env.get('BIGTABLE_EMULATOR_ENDPOINT');
const backends = [
  { name: 'PostgreSQL', env: postgresUrl, setup: postgresHarness, deferred: false },
  { name: 'MongoDB replica set', env: mongoRsUri, setup: mongoHarness, deferred: false },
  { name: 'DynamoDB Local', env: dynamoEndpoint, setup: dynamoHarness, deferred: true },
];

for (const backend of backends) {
  describe(`within-real: ${backend.name}`, { ignore: backend.env === undefined }, () => {
    let harness: BackendHarness;
    let first: ReturnType<typeof withinApp>;
    let second: ReturnType<typeof withinApp>;
    beforeAll(async () => {
      harness = await backend.setup(backend.env!);
      first = withinApp(harness.adapter());
      second = withinApp(harness.adapter());
      await first.start();
      await second.start();
    });
    afterAll(async () => {
      await first?.stop();
      await second?.stop();
      await harness?.dispose();
    });

    it('commits the happy path and replays a duplicate without running work', async () => {
      const { idempotency, database } = servicesOf(first);
      let calls = 0;
      const work = (uow: IUnitOfWork) => {
        calls++;
        return writeBusiness(uow, 'happy');
      };
      const before = await database.getRepository('Business').count();
      const a = await idempotency.within(withinOptions('happy'), work);
      const b = await idempotency.within(withinOptions('happy'), work);
      expect(a).toEqual({ value: 'happy', replayed: false });
      expect(b).toEqual({ value: 'happy', replayed: true });
      expect(calls).toBe(1);
      expect(await database.getRepository('Business').count()).toBe(before + 1);
    });

    it('a concurrent pair commits one business row and converges on the winner', async () => {
      const a = servicesOf(first);
      const b = servicesOf(second);
      const before = await a.database.getRepository('Business').count();
      const inside = deferred();
      const release = deferred();
      const both = deferred();
      let calls = 0;
      const work = (name: string) => async (uow: IUnitOfWork) => {
        calls++;
        await writeBusiness(uow, `race-${name}`);
        inside.resolve();
        if (calls === 2) both.resolve();
        await release.promise;
        return 'winner';
      };
      const winner = a.idempotency.within(withinOptions('race'), work('a'));
      await inside.promise;
      const loser = b.idempotency.within(withinOptions('race'), work('b'));
      const settled = Promise.allSettled([winner, loser]);
      if (backend.deferred) await both.promise;
      else await new Promise((resolve) => setTimeout(resolve, 200));
      release.resolve();
      const [ra, rb] = await settled;
      if (backend.deferred) {
        expect([ra, rb].map((r) => r.status === 'fulfilled' ? r.value.value : r.reason)).toEqual([
          'winner',
          'winner',
        ]);
        expect([ra, rb].map((r) => r.status === 'fulfilled' ? r.value.replayed : undefined).sort())
          .toEqual([false, true]);
      } else {expect(ra).toEqual({
          status: 'fulfilled',
          value: { value: 'winner', replayed: false },
        });}
      if (backend.name === 'MongoDB replica set') {
        expect(rb.status).toBe('rejected');
        if (rb.status !== 'rejected') throw new Error('MongoDB loser unexpectedly fulfilled');
        expect(rb.reason).toBeInstanceOf(IdempotencyWithinError);
        expect((rb.reason as IdempotencyWithinError).reason).toBe('conflict');
        expect(await b.idempotency.within(withinOptions('race'), work('retry'))).toEqual({
          value: 'winner',
          replayed: true,
        });
      } else if (!backend.deferred) {
        expect(rb).toEqual({
          status: 'fulfilled',
          value: { value: 'winner', replayed: true },
        });
      }
      expect(calls).toBe(backend.deferred ? 2 : 1);
      expect(await a.database.getRepository('Business').count()).toBe(before + 1);
    });

    it('obligation 1: two scopes and two namespaces never cross on one key', async () => {
      const { idempotency } = servicesOf(first);
      const cases = [['scope-a', 'namespace-a'], ['scope-b', 'namespace-a'], [
        'scope-a',
        'namespace-b',
      ], ['scope-b', 'namespace-b']];
      for (const [scope, namespace] of cases) {
        const value = `${scope}/${namespace}`;
        expect(
          await idempotency.within(
            withinOptions('isolation', scope, namespace),
            (uow: IUnitOfWork) => writeBusiness(uow, value),
          ),
        ).toEqual({ value, replayed: false });
      }
      for (const [scope, namespace] of cases) {
        expect(
          await idempotency.within(
            withinOptions('isolation', scope, namespace),
            () => Promise.reject(new Error('replay ran work')),
          ),
        ).toEqual({ value: `${scope}/${namespace}`, replayed: true });
      }
    });

    for (const tamper of ['wrong-envelope', 'wrong-kind', 'missing-result']) {
      it(`obligation 4: ${tamper} is never replayed or purged`, async () => {
        const { idempotency, database, store } = servicesOf(first);
        const options = withinOptions(tamper);
        await idempotency.within(options, () => Promise.resolve(tamper));
        const repo = database.getRepository<Record<string, unknown>>('Idempotency');
        const row = (await repo.findAll()).find((r) => r.result === JSON.stringify({ v: tamper }))!;
        const id = String(row.id).slice(0, -2);
        await repo.update(id, { expiresAt: 1 });
        await repo.update(`${id}.r`, { expiresAt: 1 });
        if (tamper === 'wrong-envelope') {
          await repo.update(`${id}.r`, { result: '{"forged":true}' });
        }
        if (tamper === 'wrong-kind') {
          await repo.update(`${id}.r`, { kind: 'foreign-business-record' });
        }
        if (tamper === 'missing-result') await repo.delete(`${id}.r`);
        const outcome = await idempotency.within(options, () => Promise.resolve('must-not-replay'))
          .catch((error: unknown) => error);
        expect(outcome).toBeInstanceOf(IdempotencyWithinError);
        if (tamper === 'wrong-envelope') {
          expect((outcome as IdempotencyWithinError).reason).toBe('record-invalid');
        }
        const before = await repo.findAll();
        expect(await store.purge(2, 100)).toBe(0);
        expect(await repo.findAll()).toEqual(before);
      });
    }

    it('obligation 5: an oversized result leaves no record or business row', async () => {
      const { idempotency, database } = servicesOf(first);
      const business = await database.getRepository('Business').count();
      const records = await database.getRepository('Idempotency').count();
      const failure = await idempotency.within(
        withinOptions('oversized'),
        async (uow: IUnitOfWork) => {
          await writeBusiness(uow, 'oversized');
          return 'x'.repeat(65_536);
        },
      ).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(IdempotencyWithinError);
      expect((failure as IdempotencyWithinError).reason).toBe('result-too-large');
      expect(await database.getRepository('Business').count()).toBe(business);
      expect(await database.getRepository('Idempotency').count()).toBe(records);
    });
  });
}

/** Includes non-enumerable error messages and every cause as well as metadata. */
function diagnosticText(value: unknown): string {
  if (value instanceof Error) {
    return `${value.name} ${value.message} ${value.stack ?? ''} ${diagnosticText(value.cause)}`;
  }
  return JSON.stringify(value) ?? '';
}

describe('within-real: PostgreSQL obligation 3', { ignore: postgresUrl === undefined }, () => {
  let pg: Awaited<ReturnType<typeof postgresHarness>>;
  beforeAll(async () => {
    pg = await postgresHarness(postgresUrl!);
  });
  afterAll(async () => {
    await pg?.dispose();
  });
  for (const phase of ['store-write', 'commit']) {
    it(`obligation 3: a failing ${phase} exposes no recognizable values`, async () => {
      const values = {
        key: `PRIVATE_KEY_${phase}`,
        scope: `PRIVATE_SCOPE_${phase}`,
        namespace: `PRIVATE_NAMESPACE_${phase}`,
        fingerprint: `PRIVATE_FP_${phase}`,
        result: `PRIVATE_RESULT_${phase}`,
      };
      const lines: string[] = [];
      const failures: unknown[] = [];
      const logger = {
        level: 'info',
        debug: () => {},
        info: () => {},
        warn: (message: string, meta: unknown) => lines.push(`${message} ${diagnosticText(meta)}`),
        error: (message: string, meta: unknown) => lines.push(`${message} ${diagnosticText(meta)}`),
      } as unknown as ILogger;
      const loggerPlugin: IPlugin = {
        name: `test-logger-${phase}`,
        version: '1.0.0',
        provides: [CAPABILITIES.LOGGER],
        register(ctx) {
          ctx.services.register(CAPABILITIES.LOGGER, logger);
        },
      };
      const routes: IPlugin = {
        name: `test-route-${phase}`,
        version: '1.0.0',
        register(ctx) {
          ctx.middleware.add(errorHandler());
          ctx.router.post('/probe', async (c) => {
            try {
              const { idempotency } = servicesOf(app);
              const outcome = await idempotency.within({
                ...withinOptions(values.key, values.scope, values.namespace),
                fingerprint: { input: values.fingerprint },
              }, async (uow: IUnitOfWork) => {
                await writeBusiness(uow, `leak-${phase}`);
                return values;
              });
              return c.response.json(outcome.value);
            } catch (error) {
              failures.push(error);
              throw error;
            }
          });
        },
      };
      const app = withinApp(pg.adapter(), [loggerPlugin, routes]);
      const tag = crypto.randomUUID().replaceAll('-', '');
      const fn = `reject_${tag}`;
      const trigger = `trigger_${tag}`;
      await app.start();
      try {
        await pg.pool.query(
          `CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.result IS NOT NULL THEN RAISE EXCEPTION 'PRIVATE bound result: %', NEW.result; END IF; RETURN NEW; END $$`,
        );
        await pg.pool.query(
          phase === 'commit'
            ? `CREATE CONSTRAINT TRIGGER ${trigger} AFTER INSERT ON setu_idempotency DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${fn}()`
            : `CREATE TRIGGER ${trigger} BEFORE INSERT ON setu_idempotency FOR EACH ROW EXECUTE FUNCTION ${fn}()`,
        );
        // Positive control: the actual driver failure quotes the sensitive bound value.
        const client = await pg.pool.connect();
        let native: unknown;
        try {
          await client.query('BEGIN');
          await client.query(
            "INSERT INTO setu_idempotency VALUES ($1,'setu-idempotency','result',$2,1,2,$3)",
            ['positive-control', 'f'.repeat(64), JSON.stringify(values)],
          );
          await client.query('COMMIT');
        } catch (error) {
          native = error;
        } finally {
          await client.query('ROLLBACK');
          client.release();
        }
        for (const value of Object.values(values)) expect(diagnosticText(native)).toContain(value);
        const response = await app.inject({ method: 'POST', url: 'http://127.0.0.1/probe' });
        expect(response.statusCode).toBe(503);
        expect(failures).toHaveLength(1);
        expect(failures[0]).toBeInstanceOf(IdempotencyWithinError);
        expect((failures[0] as Error).cause).toBeUndefined();
        expect(lines.length).toBeGreaterThan(0);
        for (const value of Object.values(values)) {
          expect(lines.join('\n')).not.toContain(value);
          expect(diagnosticText(failures[0])).not.toContain(value);
          expect(response.body ?? '').not.toContain(value);
        }
        const { database } = servicesOf(app);
        expect(await database.getRepository('Business').count()).toBe(0);
        expect(await database.getRepository('Idempotency').count()).toBe(0);
      } finally {
        await app.stop();
        await pg.pool.query(`DROP TRIGGER IF EXISTS ${trigger} ON setu_idempotency`);
        await pg.pool.query(`DROP FUNCTION IF EXISTS ${fn}()`);
      }
    });
  }
});

describe('within-real: backend refusals', () => {
  it('refuses Bigtable at start with bigtable-unsupported', {
    ignore: bigtableEndpoint === undefined,
  }, async () => {
    const app = withinApp(
      new BigtableAdapter({
        projectId: 'setu-m109b',
        instance: `m109b-${crypto.randomUUID()}`,
        apiEndpoint: bigtableEndpoint!,
      }),
    );
    const error = await app.start().catch((error: unknown) => error);
    await app.stop().catch(() => {});
    expect(error).toBeInstanceOf(TransactionalStoreUnavailableError);
    expect((error as TransactionalStoreUnavailableError).reason).toBe('bigtable-unsupported');
  });
  it('refuses standalone MongoDB at start with mongodb-standalone', {
    ignore: mongoUri === undefined,
  }, async () => {
    const harness = await mongoHarness(mongoUri!);
    const app = withinApp(harness.adapter());
    try {
      const error = await app.start().catch((error: unknown) => error);
      expect(error).toBeInstanceOf(TransactionalStoreUnavailableError);
      expect((error as TransactionalStoreUnavailableError).reason).toBe('mongodb-standalone');
    } finally {
      await app.stop().catch(() => {});
      await harness.dispose();
    }
  });
});
