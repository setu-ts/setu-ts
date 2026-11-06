import type {
  AgentRunRow,
  HandlerResult,
  IAgentRunStore,
  IRequestContext,
  IRuntimeServices,
} from '@setu-ts/common';
import type { ChunkLog, PositionedChunk } from './chunk-log.ts';

/** Terminal states cannot resume without an explicit retained-log position. @internal */
export function terminal(run: AgentRunRow): boolean {
  return run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled';
}
/** Subscribe before reading committed batches, then poll as a cross-instance fallback. @internal */
export async function respond(
  ctx: IRequestContext,
  row: AgentRunRow,
  deps: {
    store: IAgentRunStore;
    runtime: IRuntimeServices;
    headers: Readonly<Record<string, string>>;
    pollIntervalMs: number;
    local?: ChunkLog;
  },
): Promise<HandlerResult> {
  await Promise.resolve();
  const lastId = ctx.request.headers.get('last-event-id');
  if (!lastId && terminal(row)) return ctx.response.status(204).send();
  const match = lastId?.match(/^(\d+)\.(\d+)$/);
  let batch = match ? Number(match[1]) : -1;
  let index = match ? Number(match[2]) : -1;
  if (!Number.isSafeInteger(batch) || !Number.isSafeInteger(index)) {
    batch = -1;
    index = -1;
  }
  let closed = false;
  const wake = new Set<() => void>();
  const queued: PositionedChunk[] = [];
  const listener = (value: PositionedChunk): void => {
    queued.push(value);
    for (const resolve of wake) resolve();
  };
  deps.local?.listeners.add(listener);
  let cleanup = (): void => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      const send = (value: PositionedChunk): void => {
        if (
          closed ||
          (value.batch >= 0 &&
            (value.batch < batch || (value.batch === batch && value.index <= index)))
        )
          return;
        controller.enqueue(
          encoder.encode(
            `${value.batch < 0 ? '' : `id: ${value.batch}.${value.index}\n`}data: ${JSON.stringify(value.chunk)}\n\n`,
          ),
        );
        if (value.batch >= 0) {
          batch = value.batch;
          index = value.index;
        }
      };
      const abort = (): void => {
        closed = true;
        deps.local?.listeners.delete(listener);
        for (const resolve of wake) resolve();
      };
      cleanup = abort;
      const disconnected = (): void => {
        if (closed) return;
        controller.close();
        abort();
      };
      ctx.signal?.addEventListener('abort', disconnected, { once: true });
      if (ctx.signal?.aborted) disconnected();
      void (async () => {
        try {
          let current = row;
          const initial = await deps.store.chunks(current, 0);
          const final = initial.at(-1);
          const localLast = deps.local?.snapshot().at(-1);
          const maxBatch = localLast?.batch ?? final?.seq ?? -1;
          const maxIndex = localLast?.index ?? (final ? final.chunks.length - 1 : -1);
          if (batch > maxBatch || (batch === maxBatch && index > maxIndex)) {
            send({ batch: -1, index: -1, chunk: { type: 'reset-step' } });
            batch = current.stepChunkStart;
            index = -1;
          }
          for (const value of initial)
            for (let i = 0; i < value.chunks.length; i++)
              send({ batch: value.seq, index: i, chunk: value.chunks[i]! });
          while (!closed) {
            for (const value of await deps.store.chunks(current, Math.max(batch, 0)))
              for (let i = 0; i < value.chunks.length; i++)
                send({ batch: value.seq, index: i, chunk: value.chunks[i]! });
            for (const value of deps.local?.snapshot() ?? []) send(value);
            for (const value of queued.splice(0)) send(value);
            if (terminal(current) || current.status === 'waiting') break;
            await new Promise<void>((resolve) => {
              const done = (): void => {
                deps.runtime.clearTimeout(timer);
                wake.delete(done);
                resolve();
              };
              wake.add(done);
              const timer = deps.runtime.setTimeout(done, deps.pollIntervalMs);
              if (closed || queued.length > 0) done();
            });
            const fresh = await deps.store.get(row.id);
            if (!fresh) break;
            current = fresh;
          }
          if (!closed) {
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          }
        } catch (error) {
          if (!closed) controller.error(error);
        } finally {
          abort();
          ctx.signal?.removeEventListener('abort', disconnected);
        }
      })();
    },
    cancel() {
      cleanup();
    },
  });
  for (const [key, value] of Object.entries(deps.headers)) ctx.response.header(key, value);
  ctx.response.header('x-setu-run-id', row.id);
  return ctx.response.stream(stream);
}
