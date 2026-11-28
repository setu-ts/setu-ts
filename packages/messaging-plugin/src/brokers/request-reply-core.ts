/**
 * Transport-agnostic request-reply coordination shared by every reply-capable
 * broker.
 *
 * Rather than depend on transport headers (which not every broker populates —
 * the in-memory and Redis Streams adapters build metadata with none), the core
 * carries correlation *inside a message envelope* that rides each broker's
 * existing `publish`/`subscribe` path and its serializer. A broker gains
 * request-reply by delegating `request`/`respond` here, supplying its own
 * `publish`, `subscribe`, `uuid`, timer primitives, and — because what counts
 * as a reply inbox is transport-specific — its own {@link OpenInbox}.
 *
 * RPC traffic rides a channel derived from the caller's topic
 * (`rr.req.<topic>`), keeping it disjoint from plain `publish`/`subscribe` on
 * that topic: a pub/sub consumer never sees a request envelope, and a plain
 * publish is never swallowed by a responder.
 *
 * @module
 */

import type {
  ISubscription,
  MessageMetadata,
  RequestOptions,
  SubscribeOptions,
  TimerHandle,
} from '@setu-ts/common';
import type { OpenInbox, ReplyInbox } from './inbox.ts';
import { RemoteHandlerError, RequestTimeoutError } from '../errors.ts';

/** Default reply wait budget when {@link RequestOptions.timeoutMs} is omitted. */
const DEFAULT_TIMEOUT_MS = 5000;

/** Opens a request may try before refusing, when each inbox it gets is retired first. */
const MAX_INBOX_ACQUIRE_ATTEMPTS = 3;

/**
 * Prefix separating the RPC channel from plain pub/sub on the same topic.
 *
 * Requests are published to, and responders subscribe to, `rr.req.<topic>` —
 * never `<topic>` itself.
 */
const RR_REQUEST_PREFIX = 'rr.req.';

/** Derives the RPC channel a request travels on from its caller-facing topic. */
function requestChannel(topic: string): string {
  return `${RR_REQUEST_PREFIX}${topic}`;
}

/** Envelope wrapping a request so its correlation travels with the payload. */
interface RequestEnvelope {
  readonly kind: 'rr-request';
  readonly correlationId: string;
  readonly replyTo: string;
  readonly payload: unknown;
}

/** Envelope wrapping a reply, correlated back to its originating request. */
interface ReplyEnvelope {
  readonly kind: 'rr-reply';
  readonly correlationId: string;
  readonly ok: boolean;
  readonly payload?: unknown;
  readonly error?: string;
}

/**
 * The broker primitives {@link RequestReplyCore} composes. Every reply-capable
 * broker already implements these; the core needs nothing transport-specific.
 */
export interface RequestReplyDeps {
  /**
   * Reports an ignored fanOut request on a responder, and an inbox cleanup
   * wait in `close()` that ran past its bound.
   * @param message - Fixed warning text, carrying no message values
   * @returns Nothing
   * @throws Never; failures are swallowed by the core
   * @since 0.14.0
   */
  warn?(message: string): void;
  /** Publish a serialized message to a topic (the broker's own `publish`). */
  publish(
    topic: string,
    message: unknown,
    headers?: Readonly<Record<string, string>>,
  ): Promise<void>;
  /** Subscribe to a topic (the broker's own `subscribe`). */
  subscribe(
    topic: string,
    handler: (message: unknown, metadata: MessageMetadata) => void | Promise<void>,
    options?: SubscribeOptions,
  ): Promise<ISubscription>;
  /** Correlation-id source (the broker's `runtime.uuid`). */
  uuid(): string;
  /** Timer scheduling (the broker's `runtime.setTimeout`). */
  setTimeout(fn: () => void, ms: number): TimerHandle;
  /** Timer cancellation (the broker's `runtime.clearTimeout`). */
  clearTimeout(handle: TimerHandle): void;
  /**
   * Opens this broker's reply inbox. Transport-specific: brokers with cheap,
   * per-instance-addressable topics pass `createTopicInbox(...)`, while a
   * broker whose topics are durable cluster resources supplies its own.
   */
  openInbox: OpenInbox;
}

/** A request awaiting its correlated reply. */
interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
  readonly timer: TimerHandle;
}

function isRequestEnvelope(value: unknown): value is RequestEnvelope {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { kind?: unknown }).kind === 'rr-request'
  );
}

function isReplyEnvelope(value: unknown): value is ReplyEnvelope {
  return (
    typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'rr-reply'
  );
}

/**
 * Coordinates brokered request-reply over a broker's publish/subscribe pair.
 *
 * @since 0.1.0
 */
export class RequestReplyCore {
  #deps: RequestReplyDeps;
  #pending: Map<string, PendingRequest> = new Map();
  /** Requests whose deadline is running while they still acquire an inbox. */
  #acquiring: Set<PendingRequest> = new Set();
  /**
   * The in-flight or settled active inbox open. Detached opens remain tracked
   * until retirement completes, so invalidation and close cannot lose an
   * allocation that is still pending.
   */
  #inboxInit: Promise<ReplyInbox> | null = null;
  #inboxReply: ((message: unknown) => void) | null = null;
  readonly #retiringInboxes = new Set<Promise<void>>();
  /**
   * Lifecycle generation counter. Incremented on every `close()` call.
   * A request captures the current generation during inbox initialization.
   * After inbox initialization resolves, we verify the generation still
   * matches the current one before installing pending state or publishing.
   */
  #generation = 0;
  #warnedFanOut = false;

  /**
   * @param deps - The broker primitives to compose over
   */
  constructor(deps: RequestReplyDeps) {
    this.#deps = deps;
  }

  /**
   * Sends a request and awaits its single correlated reply.
   *
   * @typeParam TRes - The reply payload type
   * @param topic - Destination topic a responder is listening on
   * @param message - The request payload
   * @param options - Reply timeout behavior
   * @returns The reply payload
   * @throws {RequestTimeoutError} When no reply arrives within `timeoutMs` of
   *   this call, which covers opening the reply inbox and publishing
   * @throws {Error} When `close()` runs before the reply arrives
   * @throws {RemoteHandlerError} When the responder throws
   * @throws {Error} When three inboxes in a row are retired before the request can be sent
   * @since 0.1.0
   */
  async request<TRes>(
    topic: string,
    message: unknown,
    options?: RequestOptions,
    headers?: Readonly<Record<string, string>>,
  ): Promise<TRes> {
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let correlationId: string | undefined = undefined;

    // The deadline runs from this call, so a reply inbox that never finishes
    // opening still ends the request at `timeoutMs`. Tracking the request in
    // `#acquiring` until it has an inbox lets `close()` reject it there too.
    let entry!: PendingRequest;
    const reply = new Promise<TRes>((resolve, reject) => {
      const timer = this.#deps.setTimeout(() => {
        this.#acquiring.delete(entry);
        if (correlationId !== undefined) this.#pending.delete(correlationId);
        reject(new RequestTimeoutError(undefined, { topic, timeoutMs }));
      }, timeoutMs);
      entry = { resolve: resolve as (value: unknown) => void, reject, timer };
    });
    this.#acquiring.add(entry);
    // The deadline can fire while the inbox opens or publish is pending,
    // before the caller holds `reply`; observe it now so that rejection is
    // never unhandled. The caller still receives it through the returned promise.
    reply.catch(() => undefined);
    const abandon = (): void => {
      this.#deps.clearTimeout(entry.timer);
      this.#acquiring.delete(entry);
      if (correlationId !== undefined) this.#pending.delete(correlationId);
    };

    const acquiring = this.#acquireInbox();
    // The deadline or close() may win the race; a later open failure is then
    // nobody's to report.
    acquiring.catch(() => undefined);
    let inbox: ReplyInbox;
    try {
      // `reply` cannot resolve before the request is published, so the race
      // only ever ends early by rejecting with the deadline or the disconnect.
      inbox = await Promise.race([acquiring, reply as Promise<never>]);
    } catch (err) {
      abandon();
      throw err;
    }
    // A deadline or close() that landed in the same turn as the open.
    if (!this.#acquiring.delete(entry)) return reply;
    correlationId = this.#deps.uuid();
    this.#pending.set(correlationId, entry);

    const envelope: RequestEnvelope = {
      kind: 'rr-request',
      correlationId,
      replyTo: inbox.address,
      payload: message,
    };

    try {
      await this.#deps.publish(requestChannel(topic), envelope, headers);
    } catch (err) {
      abandon();
      throw err;
    }

    return reply;
  }

  /**
   * Opens or reuses the reply inbox, reacquiring when the one awaited was
   * retired before it could be used.
   * @returns The current inbox
   * @throws {Error} When `close()` ran while waiting, or three inboxes in a row
   *   were retired first
   */
  async #acquireInbox(): Promise<ReplyInbox> {
    let acquired = await this.#ensureInboxWithGeneration();
    // An inbox retired while its open was pending can still resolve; publishing
    // with its address may lose the reply. Reacquire, a bounded number of
    // times, until the inbox this request uses is the current one.
    for (let attempt = 1; ; attempt++) {
      // If `close()` was called while we were waiting, the generation will
      // have advanced and we must reject immediately.
      if (acquired.generation !== this.#generation) {
        throw new Error('Broker disconnected before a reply was received');
      }
      if (acquired.current()) return acquired.inbox;
      if (attempt >= MAX_INBOX_ACQUIRE_ATTEMPTS) {
        throw new Error('Reply inbox was retired before the request could be sent');
      }
      acquired = await this.#ensureInboxWithGeneration();
    }
  }

  /**
   * Registers a responder for a request topic. The handler's resolved value is
   * sent back to the caller; a thrown error is propagated as a
   * {@link RemoteHandlerError}.
   *
   * @param topic - The request topic to respond on
   * @param handler - Invoked per request; its result is returned to the caller
   * @param options - Consumer group behavior (load-balance competing responders)
   * @returns The active subscription
   * @since 0.1.0
   */
  respond(
    topic: string,
    handler: (message: unknown, metadata: MessageMetadata) => unknown | Promise<unknown>,
    options?: SubscribeOptions,
  ): Promise<ISubscription> {
    if (options?.fanOut === true && !this.#warnedFanOut) {
      this.#warnedFanOut = true;
      try {
        this.#deps.warn?.(
          "Messaging respond ignores fanOut; responders get the broker's queue-less delivery (every responder on RabbitMQ and memory, competing on the other brokers); pass queue to choose the group",
        );
      } catch {
        /* Reporting cannot prevent registration. */
      }
    }
    const competing =
      options?.fanOut === true
        ? options.queue === undefined
          ? undefined
          : { queue: options.queue }
        : options;
    return this.#deps.subscribe(
      requestChannel(topic),
      async (message, metadata) => {
        if (!isRequestEnvelope(message)) {
          return;
        }
        const { correlationId, replyTo, payload } = message;
        let response: ReplyEnvelope;
        try {
          const result = await handler(payload, metadata);
          response = { kind: 'rr-reply', correlationId, ok: true, payload: result };
        } catch (err) {
          const remoteMessage = err instanceof Error ? err.message : String(err);
          response = { kind: 'rr-reply', correlationId, ok: false, error: remoteMessage };
        }
        await this.#deps.publish(replyTo, response);
      },
      competing,
    );
  }

  /**
   * Tears down the reply inbox and rejects every in-flight request. Call from
   * the broker's `disconnect` so no timer or subscription leaks.
   *
   * With `retireBoundMs`, the wait for inbox opens and closes still in flight
   * is bounded: past it, one warning is logged and close returns, while each
   * open that settles later is still closed in the background.
   *
   * @param options - `retireBoundMs`: bound on the inbox cleanup wait, in ms
   * @since 0.1.0
   */
  async close(options?: { retireBoundMs?: number }): Promise<void> {
    // Increment the generation to invalidate any in-flight requests.
    this.#generation++;

    for (const pending of [...this.#pending.values(), ...this.#acquiring]) {
      this.#deps.clearTimeout(pending.timer);
      pending.reject(new Error('Broker disconnected before a reply was received'));
    }
    this.#pending.clear();
    this.#acquiring.clear();

    // Await an in-flight open before tearing down. Checking `#inbox` alone
    // missed the case where `close()` lands while `openInbox` is still
    // pending: the open then resolved into a live subscription that nothing
    // owned, and a later `request()` would open a second one on top of it.
    const init = this.#inboxInit;
    this.#inboxInit = null;
    this.#inboxReply = null;
    if (init) this.#retireInbox(init);
    const retiring = Promise.all([...this.#retiringInboxes]);
    const bound = options?.retireBoundMs;
    if (bound === undefined) {
      await retiring;
      return;
    }
    let timer: unknown;
    const expired = new Promise<boolean>((resolve) => {
      timer = this.#deps.setTimeout(() => resolve(true), bound);
    });
    const timedOut = await Promise.race([retiring.then(() => false), expired]);
    this.#deps.clearTimeout(timer);
    if (timedOut) {
      try {
        this.#deps.warn?.(
          `Messaging reply inbox cleanup did not finish within ${bound}ms; disconnect continues and closes it when it settles`,
        );
      } catch {
        /* Reporting cannot prevent close. */
      }
    }
  }

  /**
   * Drops only the inbox owned by this reply callback and closes it in the
   * background. Existing requests retain their original reply deadlines.
   * @param onReply - Identity supplied to the transport's inbox open
   * @returns Nothing; close also waits for detached inbox cleanup
   * @throws Never; retirement failures are contained as during close
   * @since 0.14.0
   * @internal
   */
  invalidateInbox(onReply: (message: unknown) => void): void {
    if (this.#inboxReply !== onReply) return;
    const init = this.#inboxInit;
    this.#inboxInit = null;
    this.#inboxReply = null;
    if (init) this.#retireInbox(init);
  }

  /**
   * Drops whatever reply inbox is cached and closes it in the background. A
   * broker calls it once its transport has closed, so an inbox a request
   * opened while `disconnect()` was draining is never reused after reconnect.
   * @returns Nothing
   * @throws Never; retirement failures are contained as during close
   * @since 0.14.0
   * @internal
   */
  discardInbox(): void {
    const init = this.#inboxInit;
    this.#inboxInit = null;
    this.#inboxReply = null;
    if (init) this.#retireInbox(init);
  }

  /** Tracks detached opens through cleanup, without leaking a rejection. */
  #retireInbox(init: Promise<ReplyInbox>): void {
    const retiring = init
      .then((inbox) => inbox.close())
      .catch(() => {
        // An open or close failure must not prevent other inbox cleanup.
      })
      .finally(() => this.#retiringInboxes.delete(retiring));
    this.#retiringInboxes.add(retiring);
  }

  /**
   * Lazily opens the per-instance reply inbox exactly once.
   *
   * A FAILED open must not be cached: the promise was memoized
   * unconditionally, so if the very first `request()` hit a broker that was
   * down, `#inboxInit` stayed a rejected promise and every later request failed
   * with that same stale error — forever, even after the broker recovered. On
   * rejection the memo is cleared so the next call retries.
   */
  /**
   * Ensures the reply inbox is open and returns it along with the current generation.
   * The generation is used to detect if `close()` was called while waiting for the inbox.
   * We capture the generation BEFORE awaiting the inbox open, so that a concurrent close()
   * will be detected when the inbox finally resolves.
   */
  #ensureInboxWithGeneration(): Promise<{
    inbox: ReplyInbox;
    generation: number;
    current: () => boolean;
  }> {
    // Capture generation BEFORE awaiting the inbox open.
    const generationAtStart = this.#generation;

    if (!this.#inboxInit) {
      const onReply = (message: unknown): void => {
        if (this.#inboxReply === onReply) this.#onReply(message);
      };
      this.#inboxReply = onReply;
      const init = this.#deps.openInbox(onReply).catch((error: unknown) => {
        if (this.#inboxInit === init) {
          this.#inboxInit = null;
          this.#inboxReply = null;
        }
        throw error;
      });
      this.#inboxInit = init;
    }
    const init = this.#inboxInit;
    return init.then((inbox) => ({
      inbox,
      generation: generationAtStart,
      current: () => this.#inboxInit === init,
    }));
  }

  /** Resolves or rejects the pending request a reply correlates to. */
  #onReply(message: unknown): void {
    if (!isReplyEnvelope(message)) {
      return;
    }
    const pending = this.#pending.get(message.correlationId);
    if (!pending) {
      // Late reply after timeout, or a duplicate from a second responder.
      return;
    }
    this.#deps.clearTimeout(pending.timer);
    this.#pending.delete(message.correlationId);
    if (message.ok) {
      pending.resolve(message.payload);
    } else {
      pending.reject(new RemoteHandlerError(message.error ?? 'unknown error'));
    }
  }
}
