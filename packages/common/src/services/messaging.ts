/**
 * Message broker contract, implemented by the MessagingPlugin's seven broker
 * adapters (in-memory, Redis Streams, RabbitMQ, NATS, Kafka, GCP Pub/Sub and
 * Azure Service Bus) under `CAPABILITIES.MESSAGING`.
 *
 * @module
 */

import { hasForbiddenAliasCharacter } from '../diagnostics/alias.ts';

/**
 * Transport header carrying a publisher's ordering key on a broker with no
 * native ordering primitive. Every first-party broker writes it beside any
 * native mapping, so it is readable from {@linkcode MessageMetadata.headers}
 * regardless of the transport.
 *
 * @since 0.9.0
 */
export const ORDERING_KEY_HEADER = 'x-setu-ordering-key';

/**
 * Transport header carrying a publisher's de-duplication id on a broker with no
 * native de-duplication primitive.
 *
 * @since 0.9.0
 */
export const DEDUPLICATION_ID_HEADER = 'x-setu-deduplication-id';

/** Maximum UTF-8 byte length of a publish ordering key or de-duplication id. @since 0.9.0 */
export const MAX_PUBLISH_ID_BYTES = 128;

const UTF8_ENCODER = new TextEncoder();

/**
 * Reports why a value is not a valid publish id (an `orderingKey` or
 * `deduplicationId`), or `null` when it is valid.
 *
 * The rule lives here because TWO packages enforce it and neither may import
 * the other (§2.2): `messaging-plugin` refuses a bad id on publish, and
 * `cloudflare-plugin`'s Workers broker drops a bad id read out of a JSON
 * envelope body a foreign producer may have written.
 *
 * @param value - The candidate value
 * @returns The first failing rule, or `null` when the value satisfies all of them
 * @since 0.9.0
 */
export function publishIdProblem(
  value: unknown,
):
  | 'not-a-string'
  | 'empty'
  | 'not-well-formed'
  | 'whitespace'
  | 'forbidden-characters'
  | 'too-long'
  | null {
  if (typeof value !== 'string') return 'not-a-string';
  if (value.length === 0) return 'empty';
  if (!value.isWellFormed()) return 'not-well-formed';
  if (value !== value.trim()) return 'whitespace';
  if (hasForbiddenAliasCharacter(value)) return 'forbidden-characters';
  if (UTF8_ENCODER.encode(value).length > MAX_PUBLISH_ID_BYTES) return 'too-long';
  return null;
}

/**
 * Whether a value is a valid publish id.
 *
 * @param value - The candidate value
 * @returns `true` when {@linkcode publishIdProblem} reports no problem
 * @since 0.9.0
 */
export function isValidPublishId(value: unknown): value is string {
  return publishIdProblem(value) === null;
}

/** Maximum number of caller headers accepted on one publish. @since 0.9.0 */
export const MAX_PUBLISH_HEADERS = 32;

/**
 * Maximum UTF-8 byte length of a publish header name. 255, not 256: an AMQP
 * header-table key is a short string, so RabbitMQ cannot carry a longer one,
 * and the bound is portable — a name passes on every broker or on none.
 *
 * @since 0.9.0
 */
export const MAX_PUBLISH_HEADER_NAME_BYTES = 255;

/** Maximum UTF-8 byte length of a publish header value. @since 0.9.0 */
export const MAX_PUBLISH_HEADER_VALUE_BYTES = 1024;

/**
 * Header names a broker or its server ACTS on, compared
 * ASCII-case-insensitively. `x-acquired-count` is measured (2026-10-07): a
 * RabbitMQ 4 quorum-queue redelivery writes it, not `x-delivery-count`.
 *
 * @since 0.9.0
 */
export const RESERVED_HEADER_NAMES: readonly string[] = Object.freeze([
  'traceparent',
  'tracestate',
  'cc',
  'bcc',
  'payload',
  'x-death',
  'x-delivery-count',
  'x-acquired-count',
  'x-delay',
]);

/** Reserved header-name PREFIXES, compared ASCII-case-insensitively. @since 0.9.0 */
export const RESERVED_HEADER_PREFIXES: readonly string[] = Object.freeze([
  'x-first-death-',
  'x-last-death-',
  'x-setu-',
  'nats-',
  'goog',
]);

/**
 * Reports why a value is not a valid caller header NAME, or `null` when it is
 * valid. The character rule is 1-256 bytes, every character in `0x21-0x7E`
 * except `:` — exactly what nats.js accepts, the strictest of the seven
 * transports.
 *
 * Shared, like {@linkcode publishIdProblem}, because the publish-side validator
 * and the Cloudflare envelope reader both enforce it and neither may import the
 * other (§2.2).
 *
 * @param name - The candidate name
 * @returns The first failing rule, or `null` when the name satisfies all of them
 * @since 0.9.0
 */
export function publishHeaderNameProblem(
  name: unknown,
):
  | 'not-a-string'
  | 'empty'
  | 'not-visible-ascii'
  | 'too-long'
  | 'reserved'
  | null {
  if (typeof name !== 'string') return 'not-a-string';
  if (name.length === 0) return 'empty';
  for (let index = 0; index < name.length; index++) {
    const code = name.charCodeAt(index);
    if (code < 0x21 || code > 0x7e || code === 0x3a) return 'not-visible-ascii';
  }
  if (UTF8_ENCODER.encode(name).length > MAX_PUBLISH_HEADER_NAME_BYTES) return 'too-long';
  const lower = name.toLowerCase();
  if (RESERVED_HEADER_NAMES.includes(lower)) return 'reserved';
  if (RESERVED_HEADER_PREFIXES.some((prefix) => lower.startsWith(prefix))) return 'reserved';
  return null;
}

/**
 * Reports why a value is not a valid caller header VALUE, or `null` when it is
 * valid.
 *
 * @param value - The candidate value
 * @returns The first failing rule, or `null` when the value satisfies all of them
 * @since 0.9.0
 */
export function publishHeaderValueProblem(
  value: unknown,
):
  | 'not-a-string'
  | 'not-well-formed'
  | 'whitespace'
  | 'forbidden-characters'
  | 'too-long'
  | null {
  if (typeof value !== 'string') return 'not-a-string';
  if (!value.isWellFormed()) return 'not-well-formed';
  if (value !== value.trim()) return 'whitespace';
  if (hasForbiddenAliasCharacter(value)) return 'forbidden-characters';
  if (UTF8_ENCODER.encode(value).length > MAX_PUBLISH_HEADER_VALUE_BYTES) return 'too-long';
  return null;
}

/**
 * Options accepted by {@linkcode IMessageBroker.publish}.
 *
 * An option a broker has no native primitive for is carried as a transport
 * header, never dropped and never refused, so portable producer code behaves
 * the same on every broker and the option stays observable through
 * {@linkcode MessageMetadata.headers}.
 *
 * `orderingKey` decides **placement** — the same key reaches the same
 * partition, retry queue or ordered subscription where the broker has one — and
 * not the order handlers **finish** in. What a handler failure does to order
 * differs per broker; a consumer that needs order compares the delivered
 * envelope's version and drops or defers a stale message.
 *
 * Every value is validated on publish and refused by name when malformed; the
 * refused value is never echoed back. A delivered `x-setu-ordering-key` or
 * `x-setu-deduplication-id` header is a **hint written by whoever published the
 * message** — validation runs on the publish side only — so a consumer may use
 * it to order or de-duplicate its own work, never to authorize anything.
 *
 * @since 0.9.0
 */
export interface PublishOptions {
  /**
   * Key that places the message: Kafka's message key, Pub/Sub's `orderingKey`,
   * and {@linkcode ORDERING_KEY_HEADER} everywhere else. At most 128 UTF-8
   * bytes, no leading/trailing whitespace, no control characters. Derive it
   * from an aggregate the application owns — never from request input, which
   * would let a caller concentrate load on one partition or ordering key, and,
   * on a log-compacted Kafka topic, erase an earlier message carrying the same
   * key.
   */
  readonly orderingKey?: string;
  /**
   * Id a broker uses to drop a duplicate re-send: NATS's `Nats-Msg-Id`,
   * Service Bus's `messageId`, RabbitMQ's `messageId`, and
   * {@linkcode DEDUPLICATION_ID_HEADER} everywhere else. At most 128 UTF-8
   * bytes, no leading/trailing whitespace, no control characters. Derive it
   * from a producer-assigned id — a caller-chosen value lets the caller
   * suppress another message within the broker's de-duplication window.
   */
  readonly deduplicationId?: string;
  /**
   * Application headers written beside the framework's own. A name a transport
   * or its server acts on (including `traceparent`, `cc`, `bcc`, `payload`,
   * `nats-*` and `x-setu-*`) is refused on every broker, as is a `goog` prefix —
   * a precaution: Pub/Sub's reservation of it is stated only by third-party
   * documentation, and the emulator accepts it.
   */
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * The validated, frozen copy {@linkcode parsePublishOptions} returns.
 *
 * @since 0.9.0
 */
export interface ParsedPublishOptions {
  /** The ordering key, when the caller supplied one. */
  readonly orderingKey?: string;
  /** The de-duplication id, when the caller supplied one. */
  readonly deduplicationId?: string;
  /** The caller's headers, `{}` when none were supplied. */
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * A plain object: prototype is `Object.prototype` or `null`, and it is not an
 * array. `Array.isArray` and `getPrototypeOf` run `Proxy` traps, so a trap that
 * throws is reported as the documented `RangeError` naming `what`, never
 * escaping as whatever the trap threw.
 */
function isPlainObject(value: unknown, what: string): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  try {
    if (Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch (error) {
    throw new RangeError(`${what} could not be read`, { cause: error });
  }
}

const ID_PROBLEM_TEXT: Readonly<Record<string, string>> = {
  'not-a-string': 'must be a non-empty string',
  'empty': 'must be a non-empty string',
  'not-well-formed': 'must be a well-formed string',
  'whitespace': 'must not have leading or trailing whitespace',
  'forbidden-characters': 'must not contain control or format characters',
  'too-long': `must be at most ${MAX_PUBLISH_ID_BYTES} UTF-8 bytes`,
};

const HEADER_VALUE_PROBLEM_TEXT: Readonly<Record<string, string>> = {
  'not-a-string': 'must be a string',
  'not-well-formed': 'must be a well-formed string',
  'whitespace': 'must not have leading or trailing whitespace',
  'forbidden-characters': 'must not contain control or format characters',
  'too-long': `must be at most ${MAX_PUBLISH_HEADER_VALUE_BYTES} UTF-8 bytes`,
};

function parseId(field: string, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const problem = publishIdProblem(value);
  if (problem !== null) {
    throw new RangeError(`publish options ${field} ${ID_PROBLEM_TEXT[problem]}`);
  }
  return value as string;
}

function parseHeaders(raw: unknown): Readonly<Record<string, string>> {
  if (!isPlainObject(raw, 'publish options headers')) {
    throw new RangeError('publish options headers must be a plain object');
  }
  let symbolCount: number;
  let names: string[];
  let values: unknown[];
  try {
    symbolCount = Object.getOwnPropertySymbols(raw).length;
    names = Object.keys(raw); // own enumerable string keys, in one pass
    values = names.map((name) => raw[name]); // each value read exactly once
  } catch (error) {
    throw new RangeError('publish options headers could not be read', { cause: error });
  }
  if (symbolCount > 0) {
    throw new RangeError('publish options headers must not contain symbol keys');
  }
  if (names.length > MAX_PUBLISH_HEADERS) {
    throw new RangeError(
      `publish options headers must contain at most ${MAX_PUBLISH_HEADERS} entries`,
    );
  }
  const entries: [string, string][] = [];
  for (let index = 0; index < names.length; index++) {
    const name = names[index]!;
    const nameProblem = publishHeaderNameProblem(name);
    if (nameProblem === 'reserved') {
      // Safe to quote: a reserved name has passed the character check.
      throw new RangeError(`publish options header ${JSON.stringify(name)} is reserved`);
    }
    if (nameProblem !== null) {
      // Never quoted: a name refused for its characters may carry anything.
      throw new RangeError(
        `publish options header at index ${index} has an invalid name: ` +
          `1-${MAX_PUBLISH_HEADER_NAME_BYTES} bytes, each in 0x21-0x7E excluding ":"`,
      );
    }
    const valueProblem = publishHeaderValueProblem(values[index]);
    if (valueProblem !== null) {
      throw new RangeError(
        `publish options header ${JSON.stringify(name)} value ${
          HEADER_VALUE_PROBLEM_TEXT[valueProblem]
        }`,
      );
    }
    entries.push([name, values[index] as string]);
  }
  // `Object.fromEntries` defines own data properties. Building by assignment
  // would hand a `__proto__` name to the `Object.prototype.__proto__` setter,
  // which Node, Bun and workerd keep (Deno deletes it), and the header would
  // be silently dropped.
  return Object.freeze(Object.fromEntries(entries));
}

/**
 * Reads and validates caller {@linkcode PublishOptions} into a frozen copy —
 * the ONE implementation every publish entry uses, in `messaging-plugin` and
 * `cloudflare-plugin` alike, neither of which may import the other.
 *
 * The caller's object is read exactly once (each member, each header value),
 * so a getter or `Proxy` cannot answer the check one value and the transport
 * another; only the returned copy is read afterwards. A refusal names the
 * field and the rule and never quotes the refused value.
 *
 * Throws SYNCHRONOUSLY: a publish method calls it inside an `async` body, which
 * turns the throw into the rejected promise its contract requires.
 *
 * @param options - The caller's options, or `undefined`
 * @returns The frozen validated copy
 * @throws {RangeError} When `options` is not a plain object, cannot be read, or
 *   any member breaks the publish id or header rules
 * @example
 * ```typescript
 * import { parsePublishOptions } from '@setu-ts/common';
 *
 * const parsed = parsePublishOptions({ orderingKey: 'order-7', headers: { 'x-tenant': 'acme' } });
 * // parsed.headers → { 'x-tenant': 'acme' }
 * ```
 * @since 0.9.0
 */
export function parsePublishOptions(options: unknown): ParsedPublishOptions {
  if (options === undefined) return Object.freeze({ headers: Object.freeze({}) });
  if (!isPlainObject(options, 'publish options')) {
    throw new RangeError('publish options must be a plain object or undefined');
  }
  let rawOrderingKey: unknown;
  let rawDeduplicationId: unknown;
  let rawHeaders: unknown;
  try {
    rawOrderingKey = options.orderingKey;
    rawDeduplicationId = options.deduplicationId;
    rawHeaders = options.headers;
  } catch (error) {
    throw new RangeError('publish options could not be read', { cause: error });
  }
  const orderingKey = parseId('orderingKey', rawOrderingKey);
  const deduplicationId = parseId('deduplicationId', rawDeduplicationId);
  const headers = rawHeaders === undefined ? Object.freeze({}) : parseHeaders(rawHeaders);
  return Object.freeze({
    ...(orderingKey !== undefined ? { orderingKey } : {}),
    ...(deduplicationId !== undefined ? { deduplicationId } : {}),
    headers,
  });
}

/**
 * Transport metadata accompanying a delivered message.
 *
 * @since 0.1.0
 */
export interface MessageMetadata {
  /** The topic the message arrived on. */
  readonly topic: string;
  /** Broker-assigned message ID, when available. */
  readonly messageId?: string;
  /** Delivery timestamp, when available. */
  readonly timestamp?: Date;
  /**
   * Transport headers read from the delivered message. First-party brokers
   * populate this with `{}` when their transport carried no headers.
   */
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * Handles messages delivered on a subscription.
 *
 * @typeParam T - The message payload type
 * @param message - The deserialized payload
 * @param metadata - Transport metadata
 * @since 0.1.0
 */
export type MessageHandler<T = unknown> = (
  message: T,
  metadata: MessageMetadata,
) => void | Promise<void>;

/**
 * Options accepted when subscribing to a topic.
 *
 * @since 0.1.0
 */
export interface SubscribeOptions {
  /** Consumer group / queue name for load-balanced delivery. */
  readonly queue?: string;
}

/**
 * Options accepted by {@linkcode IMessageBroker.request}.
 *
 * @since 0.1.0
 */
export interface RequestOptions {
  /**
   * Reply wait budget in milliseconds. When no correlated reply arrives within
   * this window, `request` rejects. Defaults to `5000` when omitted.
   */
  readonly timeoutMs?: number;
}

/**
 * Responder for a request topic. Its resolved value is sent back to the caller
 * as the reply, correlated to the originating request.
 *
 * @typeParam TReq - The request payload type
 * @typeParam TRes - The reply payload type
 * @param message - The deserialized request payload
 * @param metadata - Transport metadata for the request delivery
 * @since 0.1.0
 */
export type RequestHandler<TReq = unknown, TRes = unknown> = (
  message: TReq,
  metadata: MessageMetadata,
) => TRes | Promise<TRes>;

/**
 * An active subscription.
 *
 * @since 0.1.0
 */
export interface ISubscription {
  /**
   * Cancels the subscription.
   */
  unsubscribe(): Promise<void>;
}

/**
 * Message broker for cross-service integration events.
 *
 * @example
 * ```typescript
 * const broker = ctx.services.get<IMessageBroker>(CAPABILITIES.MESSAGING);
 * await broker.publish('user.created', { userId: user.id });
 * ```
 * @since 0.1.0
 */
export interface IMessageBroker {
  /**
   * Opens the broker connection.
   */
  connect(): Promise<void>;
  /**
   * Closes the broker connection.
   */
  disconnect(): Promise<void>;
  /**
   * Publishes a message to a topic.
   *
   * @typeParam T - The payload type
   * @param topic - Destination topic
   * @param message - The payload (serialized by the broker adapter)
   * @param options - Ordering, de-duplication and header options; an option the
   *   broker has no native primitive for is carried as a transport header
   */
  publish<T>(topic: string, message: T, options?: PublishOptions): Promise<void>;
  /**
   * Subscribes to a topic.
   *
   * @typeParam T - The payload type
   * @param topic - Source topic
   * @param handler - Invoked per delivered message
   * @param options - Consumer group behavior
   * @returns The active subscription
   */
  subscribe<T>(
    topic: string,
    handler: MessageHandler<T>,
    options?: SubscribeOptions,
  ): Promise<ISubscription>;
  /**
   * Sends a request to a topic and awaits a single correlated reply, providing
   * brokered request-reply (RPC) over the message broker.
   *
   * A responder registered with {@linkcode respond} on the same topic returns
   * the reply. The call rejects with a `RequestTimeoutError` when no reply
   * arrives within `options.timeoutMs`, and with a `RemoteHandlerError` when the
   * responder throws.
   *
   * Request traffic rides a channel derived from `topic`, disjoint from plain
   * {@linkcode publish}/{@linkcode subscribe} on that same topic — a pub/sub
   * consumer never observes an RPC request, and vice versa.
   *
   * @typeParam TReq - The request payload type
   * @typeParam TRes - The reply payload type
   * @param topic - Destination topic the responder is listening on
   * @param message - The request payload (serialized by the broker adapter)
   * @param options - Reply timeout behavior
   * @returns The reply payload
   */
  request<TReq, TRes>(topic: string, message: TReq, options?: RequestOptions): Promise<TRes>;
  /**
   * Registers a responder for a request topic. The handler's resolved value is
   * sent back to the requesting caller, correlated to the originating request.
   *
   * Pass `options.queue` to load-balance requests across competing responders.
   *
   * @typeParam TReq - The request payload type
   * @typeParam TRes - The reply payload type
   * @param topic - The request topic to respond on
   * @param handler - Invoked per request; its result is returned to the caller
   * @param options - Consumer group behavior
   * @returns The active subscription
   */
  respond<TReq, TRes>(
    topic: string,
    handler: RequestHandler<TReq, TRes>,
    options?: SubscribeOptions,
  ): Promise<ISubscription>;
  /**
   * Reports whether the broker's backend is reachable right now, for the
   * plugin's health indicator.
   *
   * Optional: a broker with no meaningful liveness check omits it, and the
   * indicator then reports only the lifecycle state (`isReady`).
   *
   * This answers a fact (reachability), not a policy: the indicator that
   * consumes it owns the `up`/`down` mapping.
   *
   * @returns `true` when the backend is reachable
   * @since 0.1.0
   */
  isHealthy?(): Promise<boolean>;
}
