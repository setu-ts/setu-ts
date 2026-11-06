import type {
  AgentRunChunkBatch,
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
/** The marker telling a client to discard its message and rebuild it from the replay. @internal */
export const REPLAY_CHUNK = { type: 'data-setu-replay', data: true } as const;
/**
 * Replay and tail a run's UI stream. Event ids are `<batch>.<index>.<epoch>`,
 * the epoch being the writer's lease version. `Last-Event-ID` resumes after
 * that exact chunk while the log agrees with it; when it names a position the
 * committed log does not hold, or one a different holder wrote (a takeover
 * rewrote unflushed positions), the client's view has diverged, so the stream
 * sends a `data-setu-replay` chunk and replays the whole log from the start.
 * Subscription happens before any read, and the committed read uses a row
 * read after subscribing, so no chunk falls between the three sources.
 * @internal
 */
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
  // Asynchronous by contract; subscription and snapshot below stay one synchronous step.
  await Promise.resolve();
  const lastId = ctx.request.headers.get('last-event-id');
  if (!lastId && terminal(row)) return ctx.response.status(204).send();
  const match = lastId?.match(/^(\d+)\.(\d+)\.(\d+)$/);
  const parsed = match ? match.slice(1).map(Number) : [];
  const resume = parsed.length === 3 && parsed.every((n) => Number.isSafeInteger(n));
  let batch = resume ? parsed[0]! : -1;
  let index = resume ? parsed[1]! : -1;
  const epoch = resume ? parsed[2]! : -1;
  let closed = false;
  let diverged = false;
  let sentEpoch = -1;
  const wake = new Set<() => void>();
  const queued: PositionedChunk[] = [];
  const listener = (value: PositionedChunk): void => {
    queued.push(value);
    for (const resolve of wake) resolve();
  };
  // Subscribe and snapshot the unflushed buffer in one synchronous step: a
  // chunk is then either in this snapshot, in the queue, or flushed later.
  deps.local?.listeners.add(listener);
  const early = deps.local?.snapshot() ?? [];
  const abort = (): void => {
    closed = true;
    deps.local?.listeners.delete(listener);
    for (const resolve of wake) resolve();
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      const send = (value: PositionedChunk): void => {
        // The cursor's batch reappearing under another writer's epoch means a
        // takeover rewrote positions this client already holds.
        if (
          value.batch >= 0 &&
          value.batch === batch &&
          sentEpoch >= 0 &&
          value.epoch !== sentEpoch
        )
          diverged = true;
        if (
          closed ||
          diverged ||
          (value.batch >= 0 &&
            (value.batch < batch || (value.batch === batch && value.index <= index)))
        )
          return;
        controller.enqueue(
          encoder.encode(
            `${value.batch < 0 ? '' : `id: ${value.batch}.${value.index}.${value.epoch}\n`}data: ${JSON.stringify(value.chunk)}\n\n`,
          ),
        );
        if (value.batch >= 0) {
          batch = value.batch;
          index = value.index;
          sentEpoch = value.epoch;
        }
      };
      const replay = (): void => {
        diverged = false;
        send({ batch: -1, index: -1, epoch: -1, chunk: REPLAY_CHUNK });
        batch = -1;
        index = -1;
        sentEpoch = -1;
      };
      const sendBatches = (batches: readonly AgentRunChunkBatch[]): void => {
        for (const value of batches)
          for (let i = 0; i < value.chunks.length; i++)
            send({
              batch: value.seq,
              index: i,
              epoch: value.leaseVersion,
              chunk: value.chunks[i]!,
            });
      };
      const disconnected = (): void => {
        if (closed) return;
        controller.close();
        abort();
      };
      ctx.signal?.addEventListener('abort', disconnected, { once: true });
      if (ctx.signal?.aborted) disconnected();
      void (async () => {
        try {
          let current = (await deps.store.get(row.id)) ?? row;
          const initial = await deps.store.chunks(current, 0);
          if (resume) {
            const committed = initial.find((value) => value.seq === batch);
            const buffered = early.filter((value) => value.batch === batch);
            const agrees = committed
              ? committed.leaseVersion === epoch && index < committed.chunks.length
              : buffered.length > 0 && buffered[0]!.epoch === epoch && index < buffered.length;
            if (agrees) sentEpoch = epoch;
            else replay();
          }
          sendBatches(initial);
          for (const value of early) send(value);
          while (!closed) {
            // Committed batches, then chunks queued since subscribing. The
            // subscribe-time snapshot already covered the buffer before that.
            sendBatches(await deps.store.chunks(current, Math.max(batch, 0)));
            for (const value of queued.splice(0)) send(value);
            if (diverged) {
              replay();
              continue;
            }
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
      abort();
    },
  });
  for (const [key, value] of Object.entries(deps.headers)) ctx.response.header(key, value);
  ctx.response.header('x-setu-run-id', row.id);
  return ctx.response.stream(stream);
}
