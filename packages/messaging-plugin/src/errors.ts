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
 * Thrown by {@link IMessageBroker.request} / {@link IMessageBroker.respond} on a
 * broker whose transport does not support brokered request-reply (Kafka, whose
 * consumer-group / auto-commit model makes per-caller reply correlation an
 * anti-pattern). Use a reply-capable broker — in-memory, Redis Streams,
 * RabbitMQ, or NATS.
 *
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
