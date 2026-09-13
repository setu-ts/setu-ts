/**
 * Error classes exported for consumer `instanceof` handling: request-reply,
 * the chain gate, the NATS JetStream prerequisites, and integration-event
 * delivery rejections.
 *
 * @module
 */

/**
 * Thrown by {@link IMessageBroker.request} when no correlated reply arrives
 * within the configured `timeoutMs` window. The pending request is abandoned
 * and its correlation entry cleaned up; a reply that arrives afterwards is
 * dropped.
 *
 * @since 0.1.0
 */
export class RequestTimeoutError extends Error {
  constructor(message = 'Request timed out waiting for a reply') {
    super(message);
    this.name = 'RequestTimeoutError';
  }
}

/**
 * Thrown by {@link IMessageBroker.request} when the remote responder threw while
 * handling the request. The responder's error message is propagated back to the
 * caller in {@linkcode remoteMessage}.
 *
 * @since 0.1.0
 */
export class RemoteHandlerError extends Error {
  /** The error message reported by the remote responder. */
  readonly remoteMessage: string;

  constructor(remoteMessage: string) {
    super(`Remote responder failed: ${remoteMessage}`);
    this.name = 'RemoteHandlerError';
    this.remoteMessage = remoteMessage;
  }
}

/**
 * Signals that a broker's transport cannot support brokered request-reply.
 *
 * **No broker throws this as of `0.3.0`.** It was introduced in
 * `0.1.0-alpha.1` for the Kafka broker, which rejected `request`/`respond`
 * outright; Kafka now implements both over a shared reply topic read by a
 * per-instance consumer group, so all seven brokers are reply-capable. The class
 * is retained so consumer `instanceof` checks written against `alpha.1` /
 * `alpha.2` keep compiling and catching.
 *
 * @deprecated No broker throws this. Nothing replaces it — delete the
 * corresponding `instanceof MessagingNotSupportedError` branch. Will be removed
 * in the next major version.
 * @since 0.1.0
 */
export class MessagingNotSupportedError extends Error {
  constructor(
    message =
      'This broker does not support request-reply; use in-memory, redis-streams, rabbitmq, or nats',
  ) {
    super(message);
    this.name = 'MessagingNotSupportedError';
  }
}

/**
 * Thrown by a cloud broker's {@linkcode IMessageBroker.connect} when the
 * runtime platform is Cloudflare Workers and the SDK cannot function (gRPC,
 * AMQP, or long-poll — not `fetch`). The throw fails {@linkcode app.start()}
 * at the earliest possible point.
 *
 * @since 0.1.0
 */
export class CloudBrokerUnavailableError extends Error {
  constructor(backend: string, specifier: string) {
    super(
      `${backend} (${specifier}) is not available on Cloudflare Workers — ` +
        'the SDK requires Node/Deno/Bun (gRPC/AMQP/long-poll, not fetch)',
    );
    this.name = 'CloudBrokerUnavailableError';
  }
}

/**
 * Thrown by {@linkcode GcpPubSubBroker} and {@linkcode ServiceBusBroker} when
 * the per-instance RPC reply subscription cannot be created (missing `Manage`
 * right or the reply topic does not exist).
 *
 * @since 0.1.0
 */
export class ReplyInboxUnavailableError extends Error {
  constructor(topic: string) {
    super(
      `Cannot create reply subscription on topic "${topic}" — ` +
        'the reply topic must pre-exist and the identity needs the Manage right',
    );
    this.name = 'ReplyInboxUnavailableError';
  }
}

/**
 * Thrown when a delivery held on the ingress behaviour-chain gate
 * (`PipelinedBroker`) waits longer than the configured
 * `chainReadyTimeoutMs` (default 10 000 ms; `0` waits forever) for the
 * behaviour chain to open.
 *
 * The gate opens at the end of `onInit`; a dispatch still held past the bound
 * means `onInit` never ran to completion — most often a plugin that publishes
 * during its own `register()` while a behaviour factory is configured, which
 * closes a circular wait (publish → delivery → gate → `onInit` → the
 * `register()` that never returns). The gate itself is left in place, so
 * later dispatches refuse the same way rather than delivering through a
 * partial chain.
 *
 * @since 0.4.0
 */
export class ChainGateTimeoutError extends Error {
  /** The bound that fired, in milliseconds. */
  readonly timeoutMs: number;

  /**
   * Creates the error reported for a dispatch that outlived the bound while
   * the gate had neither settled nor rejected.
   *
   * @param timeoutMs - The configured `chainReadyTimeoutMs` bound that fired
   */
  constructor(timeoutMs: number) {
    super(
      `Messaging behaviour chain did not open within ${timeoutMs}ms — ` +
        'delivery is held on the ingress behaviour-chain gate, and a plugin ' +
        'that publishes during its own register() is the likely cause. ' +
        'Check plugins resolving the messaging broker in register(), or set ' +
        'MessagingPlugin({ chainReadyTimeoutMs: 0 }) to wait indefinitely.',
    );
    this.name = 'ChainGateTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Why an integration-event delivery was refused before the application
 * handler ran. The four values are the four distinct producer-side faults an
 * operator triaging a dead-letter needs to tell apart.
 *
 * @since 0.6.0
 */
export type IntegrationEventRejectionReason =
  | 'malformed'
  | 'type-mismatch'
  | 'version-mismatch'
  | 'parse';

/**
 * Thrown by {@linkcode onIntegrationEvent}'s wrapper when a delivered message
 * is refused before the application handler runs. One class rather than four
 * keeps the consumer's `instanceof` branch a single import, while `reason`
 * discriminates.
 *
 * The `message` carries the whole diagnostic on its own — the reason, the
 * topic, and the expected against the observed `type`/`version` — because the
 * default in-memory composition's dispatch reporter flattens a rejection to
 * `error.message` in one log string, so on that path the structured fields
 * never reach an operator and the message is all that survives. The fields
 * serve an application's `instanceof` branch on a path that surfaces the error
 * object itself (a real broker's nack handler, or a bespoke sink on the
 * `'custom'` broker arm).
 *
 * For `reason: 'parse'`, the thrown parser error is carried as `cause` — a
 * schema error's field paths are the most useful diagnostic in the whole path.
 * The field is typed `unknown` and set verbatim: a parser that throws a
 * non-`Error` value (a string, most commonly) is preserved as-is, and the
 * rejection's own message still names the topic and reason without it.
 *
 * @since 0.6.0
 */
export class IntegrationEventRejectedError extends Error {
  /** Why the delivery was refused. */
  readonly reason: IntegrationEventRejectionReason;
  /** The topic the message was consumed from. */
  readonly topic: string;
  /** The `type` the consuming definition expects. */
  readonly expectedType: string;
  /** The `version` the consuming definition expects. */
  readonly expectedVersion: number;

  /**
   * Creates the rejection. The message is composed here so every refusal
   * reads the same way on the flattened log path.
   *
   * @param details - The refusal's structured fields, the human-readable
   *   `detail` naming the observed fault, and the parser's thrown value as
   *   `cause` when `reason` is `'parse'`
   */
  constructor(details: {
    reason: IntegrationEventRejectionReason;
    topic: string;
    expectedType: string;
    expectedVersion: number;
    detail: string;
    cause?: unknown;
  }) {
    super(
      `Integration event rejected on topic "${details.topic}" (reason: ${details.reason}) — ` +
        `expected type "${details.expectedType}" version ${details.expectedVersion}: ${details.detail}`,
      details.cause === undefined ? undefined : { cause: details.cause },
    );
    this.name = 'IntegrationEventRejectedError';
    this.reason = details.reason;
    this.topic = details.topic;
    this.expectedType = details.expectedType;
    this.expectedVersion = details.expectedVersion;
  }
}

/**
 * Thrown by {@linkcode NatsBroker.connect} when the NATS server rejects the
 * JetStream manager probe — the server does not have JetStream enabled, which
 * the nats broker requires. The platform's own error (typically the raw
 * `503` / `NO_RESPONDERS` reply for the `$JS.API` subjects) is carried as
 * {@linkcode cause}.
 *
 * Remedies: start the server with the `-js` flag, or enable `jetstream` in
 * its configuration file.
 *
 * @since 0.5.0
 */
export class JetStreamUnavailableError extends Error {
  /**
   * Creates the error reported when JetStream cannot be probed at all.
   *
   * @param cause - The platform error the probe rejected with
   */
  constructor(cause: unknown) {
    super(
      'The NATS server has no JetStream enabled, which the nats broker ' +
        'requires. Start the server with the `-js` flag (or set `jetstream` ' +
        'in its configuration).',
      { cause },
    );
    this.name = 'JetStreamUnavailableError';
  }
}

/**
 * Thrown by {@linkcode NatsBroker.connect} when the JetStream stream could
 * not be ensured: the stream is absent and `NatsOptions.streamSubjects` was
 * not supplied, or the platform refused the stream read/create. The platform's
 * own error is carried as {@linkcode cause} when there is one.
 *
 * The message names both remedies: create the stream out of band (for example
 * `nats stream add <name>`), or supply `NatsOptions.streamSubjects` so the
 * broker can create it with explicit subjects. The broker deliberately sends
 * no catch-all subject: NATS refuses `subjects: ['>']` without `no_ack`, and
 * with `no_ack` every publish would reject unobserved — so a subject set must
 * come from the application.
 *
 * @since 0.5.0
 */
export class JetStreamStreamError extends Error {
  /** The stream name the broker tried to ensure. */
  readonly stream: string;

  /**
   * Creates the error reported when the stream could not be ensured.
   *
   * @param stream - The JetStream stream name
   * @param cause - The platform error, when the stream read/create was
   *   attempted and rejected; omitted when the stream is simply absent and no
   *   subject set was configured
   */
  constructor(stream: string, cause?: unknown) {
    super(
      `JetStream stream "${stream}" could not be ensured. Create the stream ` +
        'out of band (for example `nats stream add ' + stream + '`), or supply ' +
        'NatsOptions.streamSubjects so the broker can create it with explicit ' +
        'subjects — a catch-all subject is refused by the server.',
      cause === undefined ? undefined : { cause },
    );
    this.name = 'JetStreamStreamError';
    this.stream = stream;
  }
}
