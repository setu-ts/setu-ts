/**
 * Consumes an integration event: validates the delivered envelope
 * structurally, runs the definition's parser, and only then calls the
 * application handler.
 *
 * @module
 */
import type {
  IServiceRegistry,
  MessageHandler,
  MessageMetadata,
  RegistryFactory,
  SubscribeOptions,
} from '@setu-ts/common';
import { CAPABILITIES, createCapabilityToken, publishIdProblem } from '@setu-ts/common';

import { InboxNotConfiguredError } from '../inbox/errors.ts';
import { inboxServiceOf } from '../inbox/inbox-service.ts';
import type { SubscriptionDefinition } from '../interfaces/index.ts';
import type { IntegrationEventDefinition } from './definition.ts';
import type { IntegrationEventEnvelope } from './envelope.ts';
import { parseEnvelopeData, validateEnvelope } from './envelope.ts';

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
 * Handles one delivered integration event inside the consumer inbox's
 * transaction (M108).
 *
 * The first three arguments are those of {@linkcode IntegrationEventHandler};
 * the fourth is the unit of work of the transaction the inbox marker was
 * created in. Write through it, and the writes commit together with the
 * marker or not at all. With `createDatabaseInboxStore()` it is the
 * database plugin's `IUnitOfWork`; annotate the parameter with that type and
 * `S` is inferred from the annotation.
 *
 * @typeParam T - The event payload type the definition's parser produces
 * @typeParam S - The unit-of-work type the configured inbox store supplies
 * @since 0.9.0
 */
export type IntegrationEventInboxHandler<T, S = unknown> = (
  payload: T,
  envelope: IntegrationEventEnvelope<T>,
  metadata: MessageMetadata,
  scope: S,
) => void | Promise<void>;

/**
 * The `inbox` option of {@linkcode onIntegrationEvent} (M108).
 *
 * @since 0.9.0
 */
export interface IntegrationEventInboxOptions {
  /**
   * The consumer name: one half of the inbox key `(consumer, envelope id)`,
   * and the broker `queue` when `queue` is not set. It must be the SAME on
   * every replica and every deployment of this consumer — a name that changes
   * makes every redelivered event look new. A valid publish id: at most 128
   * UTF-8 bytes, no control or format characters, no surrounding whitespace.
   */
  readonly consumer: string;
  /**
   * The named messaging instance whose inbox to use — `MessagingPlugin({ name })`,
   * resolving `inbox.<instance>`. Omitted, `CAPABILITIES.INBOX` (`inbox`).
   */
  readonly instance?: string;
}

/**
 * The options of an inbox subscription: the broker's consumer-group
 * configuration plus the `inbox` option.
 *
 * @since 0.9.0
 */
export type IntegrationEventSubscribeOptions = SubscribeOptions & {
  readonly inbox: IntegrationEventInboxOptions;
};

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
export function onIntegrationEvent<T, S = unknown>(
  definition: IntegrationEventDefinition<T>,
  handler: IntegrationEventInboxHandler<T, S>,
  options: IntegrationEventSubscribeOptions,
): RegistryFactory<SubscriptionDefinition>;
export function onIntegrationEvent<T>(
  definition: IntegrationEventDefinition<T>,
  handler: IntegrationEventHandler<T>,
  options?: SubscribeOptions & { readonly inbox?: never },
): SubscriptionDefinition;
export function onIntegrationEvent<T>(
  definition: IntegrationEventDefinition<T>,
  handler: IntegrationEventInboxHandler<T, unknown>,
  options?: SubscribeOptions & { readonly inbox?: IntegrationEventInboxOptions },
): SubscriptionDefinition | RegistryFactory<SubscriptionDefinition> {
  const inbox = options?.inbox;
  if (inbox !== undefined) {
    return inboxSubscription(definition, handler, options?.queue, inbox);
  }
  const wrapped: MessageHandler = async (
    raw: unknown,
    metadata: MessageMetadata,
  ): Promise<void> => {
    const envelope = validateEnvelope(raw, definition);
    const parsed = parseEnvelopeData(envelope, definition);
    // Rebuild `data` from the parsed value: a coercing parser returns a
    // different object than it was given, and leaving the raw value in place
    // would make `envelope.data` and `payload` two different objects with no
    // indication which is authoritative.
    const delivered: IntegrationEventEnvelope<T> = { ...envelope, data: parsed };
    await (handler as IntegrationEventHandler<T>)(delivered.data, delivered, metadata);
  };

  // `exactOptionalPropertyTypes`: `options` is omitted when absent, never
  // written as `undefined`.
  return options === undefined
    ? { topic: definition.topic, handler: wrapped }
    : { topic: definition.topic, handler: wrapped, options };
}

/**
 * Builds the inbox form of {@linkcode onIntegrationEvent} (M108 §3.2): a
 * factory that, when resolved, binds the subscription to the messaging
 * plugin's inbox and routes every delivery through it.
 *
 * The consumer name and the instance token are validated HERE, at the call,
 * so a malformed configuration fails where it is written.
 */
function inboxSubscription<T>(
  definition: IntegrationEventDefinition<T>,
  handler: IntegrationEventInboxHandler<T, unknown>,
  queue: string | undefined,
  inbox: IntegrationEventInboxOptions,
): RegistryFactory<SubscriptionDefinition> {
  const consumer = inbox.consumer;
  // The value is never quoted: it may carry anything.
  if (publishIdProblem(consumer) !== null) {
    throw new TypeError(
      'onIntegrationEvent: inbox.consumer must be a non-empty string of at most 128 UTF-8 ' +
        'bytes with no control or format characters and no surrounding whitespace',
    );
  }
  const instance = inbox.instance;
  const token = instance === undefined
    ? CAPABILITIES.INBOX
    : createCapabilityToken(`${CAPABILITIES.INBOX}.${instance}`);
  const topic = definition.topic;
  return (services: IServiceRegistry): SubscriptionDefinition => {
    if (!services.has(token)) throw new InboxNotConfiguredError(token, 'unregistered');
    const service = inboxServiceOf(services.get<object>(token));
    if (service === undefined) throw new InboxNotConfiguredError(token, 'foreign-provider');
    service.attach(consumer, topic);
    const subscription = { consumer, definition, handler };
    return {
      topic,
      handler: (raw: unknown, metadata: MessageMetadata) =>
        service.deliver(subscription, raw, metadata),
      // The consumer name is the group by default: a queue-less subscriber on
      // RabbitMQ gets a private queue whose failures are discarded, which
      // would leave the inbox nothing to de-duplicate (§3.4).
      options: { queue: queue ?? consumer },
    };
  };
}
