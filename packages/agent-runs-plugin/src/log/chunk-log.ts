import type { AgentRunJson, TimerHandle } from '@setu-ts/common';
import type { UIMessageChunk } from 'ai';
import { childId, json } from '../loop/messages.ts';
import type { Lease } from '../lease/lease.ts';

/** A position is stable before and after a flush. @internal */
export interface PositionedChunk {
  readonly batch: number;
  readonly index: number;
  readonly chunk: AgentRunJson;
}
/** Buffered durable log with same-instance subscribers. @internal */
export class ChunkLog {
  readonly lease: Lease;
  readonly options: { flushChunks: number; flushIntervalMs: number; maxLogBytes: number };
  readonly listeners: Set<(chunk: PositionedChunk) => void> = new Set();
  buffer: AgentRunJson[] = [];
  bytes = 0;
  truncated = false;
  #timer: TimerHandle | undefined;
  constructor(
    lease: Lease,
    options: { flushChunks: number; flushIntervalMs: number; maxLogBytes: number },
  ) {
    this.lease = lease;
    this.options = options;
  }
  async restore(): Promise<void> {
    for (const batch of await this.lease.store.chunks(this.lease.row, 0))
      for (const chunk of batch.chunks) {
        this.bytes += new TextEncoder().encode(JSON.stringify(chunk)).length;
        if (
          chunk &&
          typeof chunk === 'object' &&
          !Array.isArray(chunk) &&
          (chunk as Record<string, AgentRunJson>).type === 'data-setu-log-truncated'
        )
          this.truncated = true;
      }
  }
  snapshot(): PositionedChunk[] {
    return this.buffer.map((chunk, index) => ({ batch: this.lease.row.chunkCount, index, chunk }));
  }
  async emit(chunk: UIMessageChunk): Promise<void> {
    await this.lease.serial(async () => {
      const delta = chunk.type === 'text-delta' || chunk.type === 'reasoning-delta';
      const value = json(chunk);
      const size = new TextEncoder().encode(JSON.stringify(value)).length;
      if (delta && this.bytes + size > this.options.maxLogBytes) {
        // Live consumers still see omitted deltas, without a durable position.
        for (const listener of this.listeners) listener({ batch: -1, index: -1, chunk: value });
        if (this.truncated) return;
        this.truncated = true;
        this.#push(json({ type: 'data-setu-log-truncated', data: true }));
      } else {
        this.bytes += size;
        this.#push(value);
      }
      if (this.buffer.length >= this.options.flushChunks) await this.#flush();
      else if (this.#timer === undefined)
        this.#timer = this.lease.runtime.setTimeout(() => {
          this.#timer = undefined;
          void this.flush().catch(() => this.lease.stop(true));
        }, this.options.flushIntervalMs);
    });
  }
  #push(chunk: AgentRunJson): void {
    const position = { batch: this.lease.row.chunkCount, index: this.buffer.length, chunk };
    this.buffer.push(chunk);
    for (const listener of this.listeners) listener(position);
  }
  async #flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const run = this.lease.row;
    this.lease.row = await this.lease.store.appendChunks(run, {
      id: childId(run.id, run.chunkCount),
      runId: run.id,
      tenantId: run.tenantId,
      seq: run.chunkCount,
      chunks: this.buffer,
    });
    this.buffer = [];
    this.closeTimer();
  }
  async flush(): Promise<void> {
    await this.lease.serial(() => this.#flush());
  }
  closeTimer(): void {
    if (this.#timer !== undefined) {
      this.lease.runtime.clearTimeout(this.#timer);
      this.#timer = undefined;
    }
  }
}
