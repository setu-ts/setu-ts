/**
 * The example through its real composition, with a scripted model:
 *
 * - on the memory database, a refund the person approves is issued once and
 *   a denied one not at all;
 * - on PostgreSQL (`DATABASE_URL`, or the repository's `AGENT_RUNS_PG_URL`), a
 *   run parked for approval survives the application stopping: a new
 *   application instance takes the decision and finishes the run, with one
 *   refund row;
 * - when an OpenAI-compatible server answers at `AI_COMPAT_BASE_URL`
 *   (default llama.cpp on 8080), one case runs the real model.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, it } from 'node:test';
import { Pool } from 'pg';
import { CAPABILITIES } from '@setu-ts/common';
import type { IPlugin } from '@setu-ts/common';
import type { IDatabaseService } from '@setu-ts/database-plugin';
import { createTestApp } from '@setu-ts/testing';
import { createApp } from './setu.config.ts';
import { supportScript, withSupportModel } from './test/support/support-model.ts';
import type { Refund } from './src/modules/support/support.orders.ts';

const PG_URL = process.env['DATABASE_URL'] ?? process.env['AGENT_RUNS_PG_URL'];
const AI_BASE_URL = process.env['AI_COMPAT_BASE_URL'] ?? 'http://localhost:8080/v1';
const live = await fetch(`${AI_BASE_URL}/models`, { signal: AbortSignal.timeout(2_000) })
  .then((res) => res.ok)
  .catch(() => false);

type App = Awaited<ReturnType<typeof createTestApp>>;
interface View {
  status: string;
  pendingApprovals: { id: string; toolName: string }[];
}

async function appWith(databaseUrl: string | undefined, overrides: IPlugin[]): Promise<App> {
  const previous = process.env['DATABASE_URL'];
  if (databaseUrl === undefined) delete process.env['DATABASE_URL'];
  else process.env['DATABASE_URL'] = databaseUrl;
  try {
    return await createTestApp({ app: createApp(), overrides });
  } finally {
    if (previous === undefined) delete process.env['DATABASE_URL'];
    else process.env['DATABASE_URL'] = previous;
  }
}

async function start(app: App, message: string, user = 'priya'): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/runs',
    headers: { 'x-demo-user': user },
    body: { message },
  });
  assert.equal(res.statusCode, 202);
  return res.json<{ runId: string }>().runId;
}

async function until(app: App, runId: string, statuses: string[], tries = 300): Promise<View> {
  for (let i = 0; i < tries; i++) {
    // The lead may read every run it reviews.
    const view = (
      await app.inject({ method: 'GET', url: `/runs/${runId}`, headers: { 'x-demo-user': 'lead' } })
    ).json<View>();
    if (statuses.includes(view.status)) return view;
    await sleep(tries > 300 ? 500 : 10);
  }
  throw new Error(`run ${runId} never reached ${statuses.join('/')}`);
}

async function decide(app: App, runId: string, approvalId: string, approved: boolean) {
  const res = await app.inject({
    method: 'POST',
    url: `/runs/${runId}/approvals/${encodeURIComponent(approvalId)}`,
    headers: { 'x-demo-user': 'lead' },
    body: { approved },
  });
  assert.equal(res.statusCode, 202);
}

function refunds(app: App): Promise<readonly Refund[]> {
  return app.services
    .get<IDatabaseService>(CAPABILITIES.DATABASE)
    .getRepository<Refund>('Refund')
    .findAll({});
}

describe('durable agent smoke', () => {
  it('issues an approved refund once and a denied one never (memory)', async () => {
    for (const approved of [true, false]) {
      const app = await appWith(undefined, [withSupportModel(supportScript().model)]);
      try {
        const runId = await start(app, 'Refund $45 on order A-1001.');
        const waiting = await until(app, runId, ['waiting']);
        assert.equal(waiting.pendingApprovals[0]?.toolName, 'issueRefund');
        await decide(app, runId, waiting.pendingApprovals[0]!.id, approved);
        assert.equal((await until(app, runId, ['completed', 'failed'])).status, 'completed');
        assert.equal((await refunds(app)).length, approved ? 1 : 0);
      } finally {
        await app.stop();
      }
    }
  });

  it(
    'finishes a parked run in a new application instance (PostgreSQL)',
    { skip: !PG_URL },
    async () => {
      const admin = new Pool({ connectionString: PG_URL, max: 1 });
      const schema = `durable_agent_smoke_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
      await admin.query(`CREATE SCHEMA ${schema}`);
      const url = new URL(PG_URL!);
      url.searchParams.set('options', `-c search_path=${schema}`);
      const databaseUrl = url.toString();
      try {
        const setup = new Pool({ connectionString: databaseUrl, max: 1 });
        await setup.query(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
        await setup.end();

        const first = await appWith(databaseUrl, [withSupportModel(supportScript().model)]);
        let runId: string;
        let approvalId: string;
        try {
          runId = await start(first, 'Refund $45 on order A-1001.');
          approvalId = (await until(first, runId, ['waiting'])).pendingApprovals[0]!.id;
        } finally {
          // The process serving the run goes away while it waits for a person.
          await first.stop();
        }

        const second = await appWith(databaseUrl, [withSupportModel(supportScript().model)]);
        try {
          await decide(second, runId, approvalId, true);
          assert.equal((await until(second, runId, ['completed', 'failed'])).status, 'completed');
          const rows = await admin.query(
            `SELECT id, order_id, amount_cents FROM ${schema}.support_refunds`,
          );
          assert.deepEqual(rows.rows, [{ id: 'A-1001#1', order_id: 'A-1001', amount_cents: 4500 }]);
        } finally {
          await second.stop();
        }

        // Two runs refund all of A-1003 at once. Only PostgreSQL interleaves
        // them; between them they must never refund more than the order.
        const racing = await appWith(databaseUrl, [
          withSupportModel(supportScript({ orderId: 'A-1003', amountCents: 8999 }).model),
        ]);
        try {
          for (let round = 0; round < 3; round++) {
            await admin.query(`DELETE FROM ${schema}.support_refunds WHERE order_id = 'A-1003'`);
            const ids = await Promise.all([
              start(racing, 'Refund the dock in full.', 'amara'),
              start(racing, 'Refund the dock in full.', 'amara'),
            ]);
            const approvals = await Promise.all(
              ids.map(async (id) => (await until(racing, id, ['waiting'])).pendingApprovals[0]!.id),
            );
            await Promise.all(ids.map((id, i) => decide(racing, id, approvals[i]!, true)));
            for (const id of ids) await until(racing, id, ['completed', 'failed']);
            const total = await admin.query(
              `SELECT COALESCE(SUM(amount_cents), 0)::int AS cents FROM ${schema}.support_refunds WHERE order_id = 'A-1003'`,
            );
            assert.equal(total.rows[0].cents, 8999, `round ${round}`);
          }
        } finally {
          await racing.stop();
        }
      } finally {
        await admin.query(`DROP SCHEMA ${schema} CASCADE`);
        await admin.end();
      }
    },
  );

  it('parks a real model run for the refund approval', { skip: !live }, async () => {
    const app = await appWith(undefined, []);
    try {
      const runId = await start(
        app,
        'The headphones on order A-1001 rattle. Please refund $45 of the price.',
      );
      // A real model may answer without a tool; it must not fail.
      const view = await until(app, runId, ['waiting', 'completed', 'failed'], 600);
      assert.notEqual(view.status, 'failed');
      if (view.status === 'waiting')
        assert.equal(view.pendingApprovals[0]?.toolName, 'issueRefund');
      assert.equal((await refunds(app)).length, 0);
    } finally {
      await app.stop();
    }
  });
});
