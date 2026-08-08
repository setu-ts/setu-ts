/**
 * Request-reply error classes exported for consumer `instanceof` handling.
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
 * **No broker throws this as of `0.1.0-alpha.5`.** It was introduced in
 * `0.1.0-alpha.1` for the Kafka broker, which rejected `request`/`respond`
 * outright; Kafka now implements both over a shared reply topic read by a
 * per-instance consumer group, so all five brokers are reply-capable. The class
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
