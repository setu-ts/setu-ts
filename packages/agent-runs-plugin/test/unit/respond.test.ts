/* eslint-disable require-await -- Fakes preserve asynchronous provider and tool contracts. */
import { describe, it, expect, vi } from 'vitest';
import { harness, row } from '../fixtures/harness.ts';
import { respond } from '../../src/log/respond.ts';
import { claim } from '../../src/lease/lease.ts';
import { ChunkLog } from '../../src/log/chunk-log.ts';
async function read(ctx: ReturnType<Awaited<ReturnType<typeof harness>>['ctx']>): Promise<string> {
  return new Response(ctx.response.snapshot().body as ReadableStream<Uint8Array>).text();
}
describe('stream replay', () => {
  it('closes tails when the request disconnects, including before subscription', async () => {
    const h = await harness();
    try {
      await h.store.create(row());
      for (const already of [false, true]) {
        const signal = new AbortController();
        if (already) signal.abort();
        const ctx = { ...h.ctx(), signal: signal.signal };
        await respond(ctx, row(), {
          store: h.store,
          runtime: h.runtime,
          headers: {},
          pollIntervalMs: 1,
        });
        signal.abort();
        expect(await read(ctx)).toBe('');
        expect(h.timers.size).toBe(0);
      }
      const signal = new AbortController();
      const ctx = { ...h.ctx(), signal: signal.signal };
      await respond(ctx, row(), {
        store: h.store,
        runtime: h.runtime,
        headers: {},
        pollIntervalMs: 1,
      });
      const cancelled = (ctx.response.snapshot().body as ReadableStream<Uint8Array>).cancel();
      signal.abort();
      await cancelled;
    } finally {
      await h.close();
    }
  });
  it('replays exact positions (G4), malformed ids, beyond-log reset, terminal 204 and headers', async () => {
    const h = await harness();
    try {
      const { runId } = await h.service.start(h.ctx(), 'demo', { messages: [] });
      await h.settle();
      const run = (await h.store.get(runId))!;
      const idle = h.ctx();
      await h.service.respond(idle, runId);
      expect(idle.response.snapshot().status).toBe(204);
      const chunks = (await h.store.chunks(run, 0)).flatMap((b) =>
        b.chunks.map((chunk, index) => ({ id: `${b.seq}.${index}`, chunk })),
      );
      for (const last of ['broken', '0.0', '999.0', '9999999999999999999999.0']) {
        const ctx = h.ctx('tenant', 'user', new Headers({ 'last-event-id': last }));
        await h.service.respond(ctx, runId);
        const text = await read(ctx);
        expect(ctx.response.snapshot().headers.get('x-setu-run-id')).toBe(runId);
        expect(text).toContain('[DONE]');
        if (last === '0.0') {
          expect(text).not.toContain(`id: ${chunks[0]!.id}\n`);
          expect(text).toContain(`id: ${chunks[1]!.id}\n`);
        }
        if (last === '999.0') expect(text).toContain('reset-step');
      }
    } finally {
      await h.close();
    }
  });
  it('subscribes before replay, deduplicates concurrent flush and tails to waiting', async () => {
    const h = await harness();
    try {
      await h.store.create(row());
      const lease = (await claim(h.store, h.runtime, row(), 'A', 30000, 0))!;
      const log = new ChunkLog(lease, {
        flushChunks: 64,
        flushIntervalMs: 100,
        maxLogBytes: 10000,
      });
      await log.emit({ type: 'start', messageId: 'run' });
      const original = h.store.chunks.bind(h.store);
      const spy = vi.spyOn(h.store, 'chunks').mockImplementationOnce(async (run, from) => {
        await log.emit({ type: 'start-step' });
        await log.flush();
        return original({ ...run, chunkCount: lease.row.chunkCount }, from);
      });
      const ctx = h.ctx();
      await respond(ctx, lease.row, {
        store: h.store,
        runtime: h.runtime,
        headers: {},
        pollIntervalMs: 1,
        local: log,
      });
      await log.emit({ type: 'tool-approval-request', approvalId: 'approval', toolCallId: 'c' });
      await log.flush();
      await lease.write({ status: 'waiting' });
      for (let i = 0; i < 30; i++) await Promise.resolve();
      h.fire(1);
      const text = await read(ctx);
      expect(text.match(/"type":"start"/g)).toHaveLength(1);
      expect(text.match(/"type":"start-step"/g)).toHaveLength(1);
      expect(text).toContain('tool-approval-request');
      expect(text).not.toContain('"type":"finish"');
      spy.mockRestore();
      lease.stop();
    } finally {
      await h.close();
    }
  });
  it('polls another instance and cleans up a disconnected stream', async () => {
    const h = await harness();
    try {
      await h.store.create(row());
      const ctx = h.ctx();
      await respond(ctx, row(), {
        store: h.store,
        runtime: h.runtime,
        headers: {},
        pollIntervalMs: 1,
      });
      const reader = (ctx.response.snapshot().body as ReadableStream<Uint8Array>)!.getReader();
      await reader.cancel();
      expect(h.timers.size).toBe(0);
      const ctx2 = h.ctx();
      await respond(ctx2, row(), {
        store: h.store,
        runtime: h.runtime,
        headers: {},
        pollIntervalMs: 1,
      });
      await h.store.update('run', { leaseVersion: 0 }, { status: 'completed' });
      for (let i = 0; i < 30; i++) await Promise.resolve();
      h.fire(1);
      expect(await read(ctx2)).toContain('[DONE]');
    } finally {
      await h.close();
    }
  });
});
