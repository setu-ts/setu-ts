/** Fetch-based SSE client with resume and reconnect support. */

import type { IClientTiming } from '../http/contracts.ts';
import { createDefaultClientTiming } from '../http/timing.ts';
import type {
  ISseClient,
  RawSseEvent,
  SseClientOptions,
  SseClientState,
  SseEvent,
  SseEventMap,
  SseReconnectOptions,
} from './sse-contracts.ts';
import { SseFrameParser } from './sse-frame-parser.ts';

const DEFAULT_RECONNECT_DELAY_MS = 1_000;
const DEFAULT_MAX_RECONNECT_DELAY_MS = 30_000;

/** Creates and starts a portable SSE client. */
export function createSseClient<TEvents extends SseEventMap>(
  options: SseClientOptions<TEvents>,
): ISseClient {
  return new SseClient(options, options.timing ?? createDefaultClientTiming());
}

/** Internal implementation retained behind the public interface. */
class SseClient<TEvents extends SseEventMap> implements ISseClient {
  readonly #options: SseClientOptions<TEvents>;
  readonly #timing: IClientTiming;
  readonly #controller = new AbortController();
  #state: SseClientState = 'connecting';
  #lastEventId: string | undefined;
  #serverRetryMs: number | undefined;

  constructor(options: SseClientOptions<TEvents>, timing: IClientTiming) {
    this.#validate(options.reconnect);
    this.#options = options;
    this.#timing = timing;
    if (options.signal?.aborted) {
      this.#setState('closed');
      return;
    }
    options.signal?.addEventListener('abort', () => this.close(), { once: true });
    void this.#run();
  }

  get state(): SseClientState {
    return this.#state;
  }

  close(): void {
    if (this.#state === 'closed') return;
    this.#controller.abort();
    this.#setState('closed');
  }

  async #run(): Promise<void> {
    let attempts = 0;
    let delay = this.#options.reconnect?.delayMs ?? DEFAULT_RECONNECT_DELAY_MS;
    while (!this.#isClosed()) {
      try {
        await this.#consume();
        // The server controls `retry:` and the parser accepts any safe integer,
        // so an unclamped hint both breaks the documented `maxDelayMs` bound and
        // overflows a 32-bit timer, which fires immediately — a hot reconnect
        // loop driven by the peer. The configured ceiling governs it.
        delay = Math.min(
          this.#serverRetryMs ?? this.#options.reconnect?.delayMs ?? DEFAULT_RECONNECT_DELAY_MS,
          this.#options.reconnect?.maxDelayMs ?? DEFAULT_MAX_RECONNECT_DELAY_MS,
        );
      } catch (error: unknown) {
        if (this.#isClosed() || isAbortError(error)) return;
        this.#options.onError?.(error);
      }

      if (this.#isClosed() || !this.#canReconnect(attempts)) {
        this.close();
        return;
      }
      attempts++;
      this.#setState('connecting');
      try {
        await this.#timing.sleep(delay, this.#controller.signal);
      } catch {
        return;
      }
      delay = Math.min(
        delay * 2,
        this.#options.reconnect?.maxDelayMs ?? DEFAULT_MAX_RECONNECT_DELAY_MS,
      );
    }
  }

  async #consume(): Promise<void> {
    const headers = new Headers(this.#options.headers);
    if (this.#lastEventId !== undefined && this.#lastEventId !== '') {
      headers.set('Last-Event-ID', this.#lastEventId);
    }
    const response = await (this.#options.fetch ?? defaultFetch)(this.#options.url, {
      headers,
      signal: this.#controller.signal,
    });
    if (!response.ok) throw new Error(`SSE request failed with HTTP ${response.status}.`);
    if (response.body === null) throw new Error('SSE response did not include a stream body.');

    if (this.#isClosed()) {
      // `fetch` is an injectable seam; one that ignores `init.signal` resolves
      // after close() and would otherwise reopen a closed client and loop.
      await response.body.cancel().catch(() => {});
      return;
    }
    this.#setState('open');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parser = new SseFrameParser();
    const cancelReader = (): void => {
      // Node's undici reader rejects cancellation after its fetch signal has
      // already aborted. The stream is intentionally being torn down, so the
      // cancellation promise must not become an unhandled rejection.
      void reader.cancel().catch(() => {});
    };
    this.#controller.signal.addEventListener('abort', cancelReader, { once: true });
    try {
      while (!this.#isClosed()) {
        const result = await reader.read();
        if (result.done) break;
        for (const frame of parser.push(decoder.decode(result.value, { stream: true }))) {
          await this.#deliver(frame);
        }
      }
      for (const frame of parser.push(decoder.decode())) await this.#deliver(frame);
    } finally {
      this.#controller.signal.removeEventListener('abort', cancelReader);
      if (this.#isClosed()) await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  async #deliver(
    frame: {
      readonly id?: string;
      readonly event?: string;
      readonly data?: string;
      readonly retry?: number;
    },
  ): Promise<void> {
    if (frame.retry !== undefined) this.#serverRetryMs = frame.retry;
    if (frame.id !== undefined) this.#lastEventId = frame.id;
    if (frame.data === undefined) return;
    const raw: RawSseEvent = {
      event: frame.event ?? 'message',
      data: frame.data,
      ...(frame.id === undefined ? {} : { id: frame.id }),
    };
    const parsed = this.#options.parse === undefined
      ? JSON.parse(raw.data)
      : this.#options.parse(raw);
    const event: SseEvent<keyof TEvents & string, TEvents[keyof TEvents]> = {
      event: raw.event as keyof TEvents & string,
      data: parsed,
      ...(raw.id === undefined ? {} : { id: raw.id }),
    };
    await this.#options.onEvent(event);
  }

  #canReconnect(attempts: number): boolean {
    const maximum = this.#options.reconnect?.maxAttempts;
    return maximum === undefined || attempts < maximum;
  }

  #isClosed(): boolean {
    return this.#state === 'closed';
  }

  #setState(next: SseClientState): void {
    if (this.#state === next) return;
    this.#state = next;
    this.#options.onStateChange?.(next);
  }

  #validate(reconnect: SseReconnectOptions | undefined): void {
    if (
      reconnect?.maxAttempts !== undefined &&
      (!Number.isInteger(reconnect.maxAttempts) || reconnect.maxAttempts < 0)
    ) {
      throw new Error('reconnect.maxAttempts must be a non-negative integer.');
    }
    if (!isNonNegativeFinite(reconnect?.delayMs)) {
      throw new Error('reconnect.delayMs must be a finite non-negative number.');
    }
    if (!isNonNegativeFinite(reconnect?.maxDelayMs)) {
      throw new Error('reconnect.maxDelayMs must be a finite non-negative number.');
    }
  }
}

/** Resolves global fetch at call time with its global receiver intact. */
function defaultFetch(input: RequestInfo, init?: RequestInit): Promise<Response> {
  return globalThis.fetch(input, init);
}

/** Checks the structural shape of a caller-initiated abort. */
function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'name' in error &&
    error.name === 'AbortError';
}

/** Rejects timer values that native platforms would coerce into a hot loop. */
function isNonNegativeFinite(value: number | undefined): boolean {
  return value === undefined || (Number.isFinite(value) && value >= 0);
}
