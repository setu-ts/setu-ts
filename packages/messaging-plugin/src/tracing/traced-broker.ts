/** Internal telemetry decorator for message brokers. */

import {
  contextToTraceparent,
  type ISubscription,
  type ITelemetryService,
  type MessageHandler,
  parseTraceparentToContext,
  type RequestHandler,
  type RequestOptions,
  type SubscribeOptions,
  TELEMETRY_CONTEXT_OPAQUE,
  TRACEPARENT_HEADER,
} from '@setu-ts/common';
import type { MessageBrokerAdapter } from '../brokers/message-broker.ts';

/** Wraps a broker with producer and consumer tracing. @internal */
export class TracedBroker implements MessageBrokerAdapter {
  readonly #broker: MessageBrokerAdapter;
  readonly #telemetry: ITelemetryService;
  readonly #system: string;

  constructor(broker: MessageBrokerAdapter, telemetry: ITelemetryService, system: string) {
    this.#broker = broker;
    this.#telemetry = telemetry;
    this.#system = system;
  }

  connect(): Promise<void> {
    return this.#broker.connect();
  }
  disconnect(): Promise<void> {
    return this.#broker.disconnect();
  }
  isReady(): boolean {
    return this.#broker.isReady();
  }
  reachability(): Promise<boolean | undefined> {
    return this.#broker.reachability();
  }
  isHealthy(): Promise<boolean> {
    return this.#broker.isHealthy?.() ?? Promise.resolve(true);
  }

  publish<T>(topic: string, message: T): Promise<void> {
    return this.publishWithHeaders(topic, message, {});
  }

  publishWithHeaders<T>(
    topic: string,
    message: T,
    headers: Readonly<Record<string, string>>,
  ): Promise<void> {
    return this.#telemetry.withSpan(
      `publish ${topic}`,
      (span) => {
        const context = span.spanContext();
        const traceparent = contextToTraceparent({
          _opaque: TELEMETRY_CONTEXT_OPAQUE,
          ...context,
        });
        const propagated = traceparent
          ? { ...headers, [TRACEPARENT_HEADER]: traceparent }
          : headers;
        return this.#broker.publishWithHeaders(topic, message, propagated);
      },
      { kind: 'producer', attributes: this.#attributes(topic, 'publish') },
    );
  }

  subscribe<T>(
    topic: string,
    handler: MessageHandler<T>,
    options?: SubscribeOptions,
  ): Promise<ISubscription> {
    return this.subscribeWithHeaders(topic, handler, options);
  }

  subscribeWithHeaders<T>(
    topic: string,
    handler: MessageHandler<T>,
    options?: SubscribeOptions,
  ): Promise<ISubscription> {
    return this.#broker.subscribeWithHeaders(
      topic,
      (message, metadata) =>
        this.#telemetry.withSpan(
          `receive ${topic}`,
          async () => await handler(message as T, metadata),
          {
            kind: 'consumer',
            attributes: {
              ...this.#attributes(topic, 'receive'),
              ...(metadata.messageId ? { 'messaging.message.id': metadata.messageId } : {}),
            },
            parentContext: parseTraceparentToContext(
              metadata.headers?.[TRACEPARENT_HEADER] ?? null,
            ),
          },
        ),
      options,
    );
  }

  request<TReq, TRes>(topic: string, message: TReq, options?: RequestOptions): Promise<TRes> {
    return this.requestWithHeaders(topic, message, {}, options);
  }

  requestWithHeaders<TReq, TRes>(
    topic: string,
    message: TReq,
    headers: Readonly<Record<string, string>>,
    options?: RequestOptions,
  ): Promise<TRes> {
    return this.#telemetry.withSpan(
      `publish rr.req.${topic}`,
      (span) => {
        const context = span.spanContext();
        const traceparent = contextToTraceparent({
          _opaque: TELEMETRY_CONTEXT_OPAQUE,
          ...context,
        });
        return this.#broker.requestWithHeaders(
          topic,
          message,
          traceparent ? { ...headers, [TRACEPARENT_HEADER]: traceparent } : headers,
          options,
        );
      },
      { kind: 'producer', attributes: this.#attributes(`rr.req.${topic}`, 'publish') },
    );
  }

  respond<TReq, TRes>(
    topic: string,
    handler: RequestHandler<TReq, TRes>,
    options?: SubscribeOptions,
  ): Promise<ISubscription> {
    return this.#broker.respond(
      topic,
      (message, metadata) =>
        this.#telemetry.withSpan(
          `receive ${metadata.topic}`,
          async () => await handler(message as TReq, metadata),
          {
            kind: 'consumer',
            attributes: {
              ...this.#attributes(metadata.topic, 'receive'),
              ...(metadata.messageId ? { 'messaging.message.id': metadata.messageId } : {}),
            },
            parentContext: parseTraceparentToContext(
              metadata.headers?.[TRACEPARENT_HEADER] ?? null,
            ),
          },
        ),
      options,
    );
  }

  #attributes(topic: string, operation: 'publish' | 'receive'): Readonly<Record<string, string>> {
    return {
      'messaging.system': this.#system,
      'messaging.destination.name': topic,
      'messaging.operation': operation,
    };
  }
}
