/**
 * The wire shape every message on a Setu-TS Cloudflare queue carries.
 *
 * A Cloudflare queue has no topic concept — a binding addresses one queue and
 * nothing else — so the topic has to travel inside the body, alongside enough
 * discriminant to tell an ordinary publish from an RPC request. That is the
 * whole reason this envelope exists.
 *
 * The shape is **internal to this package**. No other broker in the repository
 * speaks Cloudflare Queues, so there is no cross-broker wire compatibility to
 * preserve, which is what lets the RPC channel be a `kind` discriminant here
 * rather than the derived `rr.req.<topic>` channel `messaging-plugin` needs.
 * There, a request published to `<topic>` would leak into plain `subscribe()`
 * consumers; here, dispatch reads `kind` before it consults the subscription
 * table, so a plain subscriber structurally cannot observe a request.
 *
 * @module
 * @since 0.2.0
 */

/** Current envelope version. A body carrying anything else is not ours. */
const ENVELOPE_VERSION = 1;

/** An ordinary `publish` travelling to a topic's subscribers. */
export interface PublishEnvelope {
  /** Envelope version. */
  readonly v: typeof ENVELOPE_VERSION;
  /** Discriminant. */
  readonly kind: 'msg';
  /** The topic the caller published to. */
  readonly topic: string;
  /** Message id, surfaced to handlers as `MessageMetadata.messageId`. */
  readonly id: string;
  /** The caller's payload. */
  readonly payload: unknown;
}

/** An RPC request awaiting a correlated reply. */
export interface RequestEnvelope {
  /** Envelope version. */
  readonly v: typeof ENVELOPE_VERSION;
  /** Discriminant. */
  readonly kind: 'rpc-req';
  /** The topic a responder is registered on. */
  readonly topic: string;
  /** Message id, surfaced to the responder as `MessageMetadata.messageId`. */
  readonly id: string;
  /** Correlates the reply back to the waiting caller. */
  readonly correlationId: string;
  /** The reply inbox address — a Durable Object name, never a queue topic. */
  readonly replyTo: string;
  /** The caller's request payload. */
  readonly payload: unknown;
}

/**
 * A reply travelling back to its caller.
 *
 * Never carried on the queue: replies reach the caller's isolate through the
 * reply-inbox Durable Object, because a queue can only reach the one Worker
 * configured as its consumer.
 */
export interface ReplyEnvelope {
  /** Envelope version. */
  readonly v: typeof ENVELOPE_VERSION;
  /** Discriminant. */
  readonly kind: 'rpc-reply';
  /** The request this replies to. */
  readonly correlationId: string;
  /** Whether the responder resolved (`true`) or threw (`false`). */
  readonly ok: boolean;
  /** The responder's resolved value, when `ok`. */
  readonly payload?: unknown;
  /** The responder's error message, when not `ok`. */
  readonly error?: string;
}

/** Every envelope a Cloudflare queue carries for this broker. */
export type QueueEnvelope = PublishEnvelope | RequestEnvelope;

/** Reads a candidate's own `kind`, or `undefined` when it is not an object. */
function kindOf(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  return (value as { kind?: unknown }).kind;
}

/** Whether a candidate carries the current version and string `topic`/`id`. */
function hasEnvelopeHead(value: object): boolean {
  const head = value as { v?: unknown; topic?: unknown; id?: unknown };
  return head.v === ENVELOPE_VERSION && typeof head.topic === 'string' &&
    typeof head.id === 'string';
}

/**
 * Builds the body of an ordinary publish.
 *
 * @param topic - The caller's topic
 * @param id - Message id, from `IRuntimeServices.uuid()`
 * @param payload - The caller's payload
 * @returns The envelope to hand to the producer binding
 * @example
 * ```typescript
 * await producer.send(encodePublishEnvelope('user.created', runtime.uuid(), { id: 7 }));
 * ```
 * @since 0.2.0
 */
export function encodePublishEnvelope(
  topic: string,
  id: string,
  payload: unknown,
): PublishEnvelope {
  return { v: ENVELOPE_VERSION, kind: 'msg', topic, id, payload };
}

/**
 * Builds the body of an RPC request.
 *
 * @param topic - The topic a responder is registered on
 * @param id - Message id, from `IRuntimeServices.uuid()`
 * @param correlationId - Correlates the reply back to this caller
 * @param replyTo - The reply inbox address the responder delivers to
 * @param payload - The caller's request payload
 * @returns The envelope to hand to the producer binding
 * @since 0.2.0
 */
export function encodeRequestEnvelope(
  topic: string,
  id: string,
  correlationId: string,
  replyTo: string,
  payload: unknown,
): RequestEnvelope {
  return { v: ENVELOPE_VERSION, kind: 'rpc-req', topic, id, correlationId, replyTo, payload };
}

/**
 * Builds a reply.
 *
 * @param correlationId - The request being replied to
 * @param outcome - The responder's resolved value, or the message it threw
 * @returns The reply envelope to deliver to the caller's inbox
 * @since 0.2.0
 */
export function encodeReplyEnvelope(
  correlationId: string,
  outcome: { readonly ok: true; readonly payload: unknown } | {
    readonly ok: false;
    readonly error: string;
  },
): ReplyEnvelope {
  return outcome.ok
    ? { v: ENVELOPE_VERSION, kind: 'rpc-reply', correlationId, ok: true, payload: outcome.payload }
    : { v: ENVELOPE_VERSION, kind: 'rpc-reply', correlationId, ok: false, error: outcome.error };
}

/**
 * Narrows a queue message body to an envelope this broker produced.
 *
 * @param value - The message body, as the platform delivered it
 * @returns Whether it is a readable envelope
 * @since 0.2.0
 */
export function isQueueEnvelope(value: unknown): value is QueueEnvelope {
  return isPublishEnvelope(value) || isRequestEnvelope(value);
}

/**
 * Narrows a queue message body to an ordinary publish.
 *
 * @param value - The message body
 * @returns Whether it is a publish envelope
 * @since 0.2.0
 */
export function isPublishEnvelope(value: unknown): value is PublishEnvelope {
  return kindOf(value) === 'msg' && hasEnvelopeHead(value as object);
}

/**
 * Narrows a queue message body to an RPC request.
 *
 * @param value - The message body
 * @returns Whether it is a request envelope
 * @since 0.2.0
 */
export function isRequestEnvelope(value: unknown): value is RequestEnvelope {
  if (kindOf(value) !== 'rpc-req' || !hasEnvelopeHead(value as object)) return false;
  const candidate = value as { correlationId?: unknown; replyTo?: unknown };
  return typeof candidate.correlationId === 'string' && typeof candidate.replyTo === 'string';
}

/**
 * Narrows a body delivered to a reply inbox to a reply.
 *
 * @param value - The delivered body
 * @returns Whether it is a reply envelope
 * @since 0.2.0
 */
export function isReplyEnvelope(value: unknown): value is ReplyEnvelope {
  if (kindOf(value) !== 'rpc-reply') return false;
  const candidate = value as { v?: unknown; correlationId?: unknown; ok?: unknown };
  return candidate.v === ENVELOPE_VERSION && typeof candidate.correlationId === 'string' &&
    typeof candidate.ok === 'boolean';
}
