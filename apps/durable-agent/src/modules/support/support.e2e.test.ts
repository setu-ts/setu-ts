import { describe, it } from 'node:test';
import assert from 'node:assert';
import { setTimeout as sleep } from 'node:timers/promises';
import { startTestServer } from '../../../test/support/server.ts';
import { supportScript, withSupportModel } from '../../../test/support/support-model.ts';

// The memory database; `restart.e2e.test.ts` covers PostgreSQL across a restart.
delete process.env['DATABASE_URL'];

/** Reads an SSE response to its end: every event's id and parsed data. */
async function events(res: Response): Promise<{ id?: string; data: { type: string } }[]> {
  const text = await res.text();
  return text
    .split('\n\n')
    .filter((frame) => frame.includes('data: ') && !frame.includes('data: [DONE]'))
    .map((frame) => {
      const id = /^id: (.*)$/m.exec(frame)?.[1];
      const data = JSON.parse(/^data: (.*)$/m.exec(frame)![1]!) as { type: string };
      return id === undefined ? { data } : { id, data };
    });
}

describe('support e2e', () => {
  it('streams a run over HTTP, resumes after Last-Event-ID, and serves the page', async () => {
    const { model } = supportScript();
    const server = await startTestServer([withSupportModel(model)]);
    try {
      const started = await fetch(`${server.baseUrl}/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'Refund $45 on order A-1001, please.' }),
      });
      assert.deepStrictEqual(started.status, 202);
      const { runId } = (await started.json()) as { runId: string };
      // The stream ends when the run parks for approval: no `finish` yet.
      const first = await fetch(`${server.baseUrl}/runs/${runId}/stream`);
      assert.deepStrictEqual(first.status, 200);
      assert.match(first.headers.get('content-type') ?? '', /text\/event-stream/);
      assert.deepStrictEqual(first.headers.get('x-setu-run-id'), runId);
      const parked = await events(first);
      const types = parked.map((e) => e.data.type);
      assert.ok(types.includes('tool-approval-request'), types.join(','));
      assert.ok(!types.includes('finish'));
      for (const event of parked.filter((e) => e.id !== undefined))
        assert.match(event.id!, /^\d+\.\d+\.\d+$/);
      // Resuming after the third event sends exactly what came after it.
      const third = parked.filter((e) => e.id !== undefined)[2]!;
      const resumed = await events(
        await fetch(`${server.baseUrl}/runs/${runId}/stream`, {
          headers: { 'last-event-id': third.id! },
        }),
      );
      assert.deepStrictEqual(
        resumed.map((e) => e.id),
        parked
          .filter((e) => e.id !== undefined)
          .slice(3)
          .map((e) => e.id),
      );
      const view = (await (await fetch(`${server.baseUrl}/runs/${runId}`)).json()) as {
        pendingApprovals: { id: string }[];
      };
      const decided = await fetch(
        `${server.baseUrl}/runs/${runId}/approvals/${encodeURIComponent(view.pendingApprovals[0]!.id)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ approved: true }),
        },
      );
      assert.deepStrictEqual(decided.status, 202);
      let finished = false;
      for (let i = 0; i < 200 && !finished; i++) {
        const tail = await events(
          await fetch(`${server.baseUrl}/runs/${runId}/stream`, {
            headers: { 'last-event-id': parked.filter((e) => e.id !== undefined).at(-1)!.id! },
          }),
        );
        finished = tail.some((e) => e.data.type === 'finish');
        if (!finished) await sleep(10);
      }
      assert.ok(finished, 'the run finished');
      // A finished run with nothing to resume answers 204, the SDK's signal.
      const idle = await fetch(`${server.baseUrl}/runs/${runId}/stream`);
      assert.deepStrictEqual(idle.status, 204);
      // `/ui` and `/ui/` both serve the page, whose script path does not
      // depend on the trailing slash.
      for (const path of ['/ui', '/ui/']) {
        const page = await fetch(`${server.baseUrl}${path}`);
        assert.deepStrictEqual(page.status, 200);
        const html = await page.text();
        assert.match(html, /Durable support agent/);
        assert.match(html, /<script src="\/ui\/run\.js"><\/script>/);
      }
      const script = await fetch(`${server.baseUrl}/ui/run.js`);
      assert.deepStrictEqual(script.status, 200);
      await script.text();
    } finally {
      await server.stop();
    }
  });
});
