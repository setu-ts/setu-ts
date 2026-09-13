/**
 * Consumes an integration event: validates the delivered envelope
 * structurally, runs the definition's parser, and only then calls the
 * application handler.
 *
 * @module
 */
import type { MessageHandler, MessageMetadata, SubscribeOptions } from '@setu-ts/common';

import { IntegrationEventRejectedError } from '../errors.ts';
import type { SubscriptionDefinition } from '../interfaces/index.ts';
import type { IntegrationEventDefinition } from './definition.ts';
import type { IntegrationEventEnvelope } from './envelope.ts';
import { validateEnvelope } from './envelope.ts';

/**
 * Handles one delivered integration event.
 *
 * @typeParam T - The event payload type the definition's parser produces
 * @param payload - The parsed payload (`envelope.data` after `parse`)
 * @param envelope - The validated envelope, rebuilt with its `data` set to
 *   the parsed value, so `envelope.data === payload` holds for every delivery
 * @param metadata - Transport metadata, exactly as the imperative
 *   `broker.subscribe` handler receives it
 * @since 0.6.0
 */
export type IntegrationEventHandler<T> = (
  payload: T,
  envelope: IntegrationEventEnvelope<T>,
  metadata: MessageMetadata,
) => void | Promise<void>;

/**
 * Produces a {@linkcode SubscriptionDefinition} for an integration-event
 * contract — the declarative form, plugging straight into
 * `MessagingPlugin({ subscriptions })`, or spread by hand into an imperative
 * `broker.subscribe` after `start()`.
 *
 * The returned wrapper validates the delivered message against the
 * definition, runs `definition.parse`, rebuilds the envelope with its `data`
 * set to the parsed value, and only then invokes the application handler. A
 * malformed envelope, a mismatched `type`/`version`, or a rejecting parser
 * throws {@linkcode IntegrationEventRejectedError} — the application handler
 * is never called with an unvalidated value — and the rejection follows the
 * broker's OWN failure path, which differs per arm and is not a retry
 * guarantee: RabbitMQ nacks with requeue DISABLED (dead-lettered when a DLX is
 * configured, discarded otherwise) and logs; NATS naks, which redelivers while
 * the stream retains the message; the in-memory broker reports to
 * `onDispatchError` and drops. Since a rejection here is deterministic — the
 * same envelope fails the same way every time — redelivery cannot resolve it,
 * so a dead-letter queue, not a retry, is the place to inspect one. When `MessagingPlugin({ behaviors })`
 * is configured, the behaviour chain runs BEFORE this wrapper, so
 * `IngressContext.payload` is the raw envelope and never the parsed payload.
 *
 * A handler needing a resolved capability uses the existing
 * `RegistryFactory<SubscriptionDefinition>` arm of `SubscriptionEntry`:
 * `(services) => onIntegrationEvent(definition, handlerFor(services))` — no
 * factory variant of this function exists, and none is needed.
 *
 * @typeParam T - The event payload type
 * @param definition - The contract being consumed
 * @param handler - The application handler
 * @param options - Consumer-group configuration, forwarded unchanged to
 *   `broker.subscribe`
 * @returns The subscription definition to register
 * @example
 * ```typescript
 * import { onIntegrationEvent } from '@setu-ts/messaging-plugin';
 *
 * const app = createApplication({
 *   plugins: [
 *     MessagingPlugin({
 *       subscriptions: [
 *         onIntegrationEvent(orderPlaced, async (payload) => {
 *           await provisionOrder(payload.orderId);
 *         }),
 *       ],
 *     }),
 *   ],
 * });
 * ```
 * @since 0.6.0
 */
export function onIntegrationEvent<T>(
  definition: IntegrationEventDefinition<T>,
  handler: IntegrationEventHandler<T>,
  options?: SubscribeOptions,
): SubscriptionDefinition {
  const wrapped: MessageHandler = async (
    raw: unknown,
    metadata: MessageMetadata,
  ): Promise<void> => {
    const envelope = validateEnvelope(raw, definition);
    let parsed: T;
    try {
      parsed = definition.parse(envelope.data);
    } catch (cause) {
      throw new IntegrationEventRejectedError({
        reason: 'parse',
        topic: definition.topic,
        expectedType: definition.type,
        expectedVersion: definition.version,
        detail: `the parse function rejected the payload — ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
        cause,
      });
    }
    // Rebuild `data` from the parsed value: a coercing parser returns a
    // different object than it was given, and leaving the raw value in place
    // would make `envelope.data` and `payload` two different objects with no
    // indication which is authoritative.
    const delivered: IntegrationEventEnvelope<T> = { ...envelope, data: parsed };
    await handler(delivered.data, delivered, metadata);
  };

  // `exactOptionalPropertyTypes`: `options` is omitted when absent, never
  // written as `undefined`.
  return options === undefined
    ? { topic: definition.topic, handler: wrapped }
    : { topic: definition.topic, handler: wrapped, options };
}
