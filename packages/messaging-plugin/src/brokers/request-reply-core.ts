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
} from '@hono-enterprise/common';
import type { OpenInbox, ReplyInbox } from './inbox.ts';
import { RemoteHandlerError, RequestTimeoutError } from '../errors.ts';

/** Default reply wait budget when {@link RequestOptions.timeoutMs} is omitted. */
const DEFAULT_TIMEOUT_MS = 5000;

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
  /** Publish a serialized message to a topic (the broker's own `publish`). */
  publish(topic: string, message: unknown): Promise<void>;
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
  return typeof value === 'object' && value !== null &&
    (value as { kind?: unknown }).kind === 'rr-request';
}

function isReplyEnvelope(value: unknown): value is ReplyEnvelope {
  return typeof value === 'object' && value !== null &&
    (value as { kind?: unknown }).kind === 'rr-reply';
}

/**
 * Coordinates brokered request-reply over a broker's publish/subscribe pair.
 *
 * @since 0.1.0
 */
export class RequestReplyCore {
  #deps: RequestReplyDeps;
  #pending: Map<string, PendingRequest> = new Map();
  /**
   * The in-flight or settled inbox open. This is the SINGLE handle on the
   * inbox: tracking a resolved `ReplyInbox` separately meant `close()` could
   * observe a null one while the open was still pending, and miss it.
   */
  #inboxInit: Promise<ReplyInbox> | null = null;

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
   * @throws {RequestTimeoutError} When no reply arrives within `timeoutMs`
   * @throws {RemoteHandlerError} When the responder throws
   * @since 0.1.0
   */
  async request<TRes>(topic: string, message: unknown, options?: RequestOptions): Promise<TRes> {
    const inbox = await this.#ensureInbox();

    const correlationId = this.#deps.uuid();
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const reply = new Promise<TRes>((resolve, reject) => {
      const timer = this.#deps.setTimeout(() => {
        this.#pending.delete(correlationId);
        reject(new RequestTimeoutError());
      }, timeoutMs);
      this.#pending.set(correlationId, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
    });

    const envelope: RequestEnvelope = {
      kind: 'rr-request',
      correlationId,
      replyTo: inbox.address,
      payload: message,
    };

    try {
      await this.#deps.publish(requestChannel(topic), envelope);
    } catch (err) {
      const pending = this.#pending.get(correlationId);
      if (pending) {
        this.#deps.clearTimeout(pending.timer);
        this.#pending.delete(correlationId);
      }
      throw err;
    }

    return reply;
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
    return this.#deps.subscribe(requestChannel(topic), async (message, metadata) => {
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
    }, options);
  }

  /**
   * Tears down the reply inbox and rejects every in-flight request. Call from
   * the broker's `disconnect` so no timer or subscription leaks.
   *
   * @since 0.1.0
   */
  async close(): Promise<void> {
    for (const pending of this.#pending.values()) {
      this.#deps.clearTimeout(pending.timer);
      pending.reject(new Error('Broker disconnected before a reply was received'));
    }
    this.#pending.clear();

    // Await an in-flight open before tearing down. Checking `#inbox` alone
    // missed the case where `close()` lands while `openInbox` is still
    // pending: the open then resolved into a live subscription that nothing
    // owned, and a later `request()` would open a second one on top of it.
    const init = this.#inboxInit;
    this.#inboxInit = null;
    if (init) {
      try {
        const inbox = await init;
        await inbox.close();
      } catch {
        // The open itself failed, so there is no subscription to release.
      }
    }
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
  #ensureInbox(): Promise<ReplyInbox> {
    if (!this.#inboxInit) {
      this.#inboxInit = this.#deps.openInbox((message) => {
        this.#onReply(message);
      }).catch((error: unknown) => {
        this.#inboxInit = null;
        throw error;
      });
    }
    return this.#inboxInit;
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
