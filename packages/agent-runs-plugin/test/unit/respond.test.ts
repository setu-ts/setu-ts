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
        b.chunks.map((chunk, index) => ({ id: `${b.seq}.${index}.${b.leaseVersion}`, chunk })),
      );
      const exact = chunks[0]!.id;
      const [b0, i0, e0] = exact.split('.');
      const otherEpoch = `${b0}.${i0}.${Number(e0) + 1}`;
      const pastBatch = `${b0}.${chunks.filter((c) => c.id.startsWith(`${b0}.`)).length}.${e0}`;
      for (const last of [
        'broken',
        '0.0',
        exact,
        '999.0.1',
        otherEpoch,
        pastBatch,
        '9999999999999999999999.0.1',
      ]) {
        const ctx = h.ctx('tenant', 'user', new Headers({ 'last-event-id': last }));
        await h.service.respond(ctx, runId);
        const text = await read(ctx);
        expect(ctx.response.snapshot().headers.get('x-setu-run-id')).toBe(runId);
        expect(text).toContain('[DONE]');
        if (last === exact) {
          expect(text).not.toContain(`id: ${chunks[0]!.id}\n`);
          expect(text).toContain(`id: ${chunks[1]!.id}\n`);
          expect(text).not.toContain('data-setu-replay');
        } else if (last === 'broken' || last === '0.0') {
          // An unparseable id is no resume point: plain replay, no marker.
          expect(text).toContain(`id: ${chunks[0]!.id}\n`);
          expect(text).not.toContain('data-setu-replay');
        } else {
          // A position the log does not hold, or one another holder wrote:
          // the marker, then the whole log from the start.
          expect(text.indexOf('data-setu-replay')).toBeLessThan(
            text.indexOf(`id: ${chunks[0]!.id}\n`),
          );
          expect(text).toContain(`id: ${chunks[0]!.id}\n`);
        }
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
        // The real store filters by the row it is given; no counter refresh here.
        return original(run, from);
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
  it('resumes inside an unflushed local buffer only for the same holder epoch (review M1)', async () => {
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
      await log.emit({ type: 'start-step' });
      const epoch = lease.row.leaseVersion;
      const open = async (last: string): Promise<string> => {
        const ctx = h.ctx('tenant', 'user', new Headers({ 'last-event-id': last }));
        await respond(ctx, lease.row, {
          store: h.store,
          runtime: h.runtime,
          headers: {},
          pollIntervalMs: 1,
          local: log,
        });
        await lease.write({ status: 'waiting' });
        for (let i = 0; i < 30; i++) await Promise.resolve();
        h.fire(1);
        const text = await read(ctx);
        await lease.write({ status: 'running' });
        return text;
      };
      const same = await open(`0.0.${epoch}`);
      expect(same).not.toContain('data-setu-replay');
      expect(same).not.toContain('"type":"start"');
      expect(same).toContain(`id: 0.1.${epoch}\n`);
      // A different holder wrote these positions: discard and replay.
      const other = await open(`0.0.${epoch + 1}`);
      expect(other).toContain('data-setu-replay');
      expect(other).toContain(`id: 0.0.${epoch}\n`);
      // Past the buffer's end.
      expect(await open(`0.5.${epoch}`)).toContain('data-setu-replay');
      lease.stop();
    } finally {
      await h.close();
    }
  });
  it('ends the stream when the run disappears and errors it on a store fault', async () => {
    const h = await harness();
    try {
      const gone = h.ctx();
      await respond(gone, row(), {
        store: h.store,
        runtime: h.runtime,
        headers: {},
        pollIntervalMs: 1,
      });
      for (let i = 0; i < 30; i++) await Promise.resolve();
      h.fire(1);
      expect(await read(gone)).toBe('data: [DONE]\n\n');
      vi.spyOn(h.store, 'chunks').mockRejectedValueOnce(new Error('store down'));
      const failing = h.ctx();
      await respond(failing, row(), {
        store: h.store,
        runtime: h.runtime,
        headers: {},
        pollIntervalMs: 1,
      });
      await expect(read(failing)).rejects.toThrow('store down');
    } finally {
      await h.close();
    }
  });
});
