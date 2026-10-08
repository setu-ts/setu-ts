/**
 * Publishes an integration event, and derives the causal metadata one
 * consumed event contributes to the next.
 *
 * @module
 */
import type { IMessageBroker, IRuntimeServices, PublishOptions } from '@setu-ts/common';

import type { IntegrationEventDefinition } from './definition.ts';
import type { IntegrationEventEnvelope } from './envelope.ts';
import { prepareIntegrationPublish } from './prepare.ts';

/**
 * Optional causal metadata for {@linkcode publishIntegrationEvent}.
 *
 * Each field is omitted from the published envelope when absent — never
 * written as `undefined`. {@linkcode causedBy} returns a value assignable to
 * this interface.
 *
 * @since 0.6.0
 */
export interface IntegrationEventMetadata {
  /** ID of the causal chain root this event descends from. */
  readonly correlationId?: string;
  /** ID of the event that directly caused this one. */
  readonly causationId?: string;
  /** ID of the aggregate the event concerns. */
  readonly aggregateId?: string;
  /** Version of the aggregate the event concerns. */
  readonly aggregateVersion?: number;
}

/**
 * Publishes one integration event: builds the envelope from the caller's
 * already-typed payload and hands it to `broker.publish` on the definition's
 * topic.
 *
 * The definition's `parse` function is deliberately NOT run here. `parse` is a
 * narrowing function `unknown → T`, and a realistic one (a schema with
 * defaults, coercion, or stripping) returns a different object than it was
 * given — running it on publish would silently change what the producer asked
 * to send. It also would not buy the guarantee it appears to: what the
 * consumer parses is the value after a JSON round trip, which this call has
 * not seen. The consequence is honest and documented: a producer CAN publish a
 * payload its own consumers reject, and that surfaces at the consumer as a
 * `reason: 'parse'` rejection.
 *
 * @typeParam T - The event payload type
 * @param runtime - Runtime services supplying `uuid()` and `now()`
 * @param broker - The broker to publish through
 * @param definition - The contract being published
 * @param payload - The event payload, carried verbatim
 * @param metadata - Optional causal metadata
 * @param options - Optional publish options (M106 §3.7); `orderingKey` beats
 *   the definition's selector, and `deduplicationId` defaults to the envelope id
 * @throws {RangeError} As a rejected promise when the options (or the value the
 *   definition's selector returns) fail §3.4 validation
 * @throws Whatever `broker.publish` rejects with, unchanged
 * @example
 * ```typescript
 * import { publishIntegrationEvent } from '@setu-ts/messaging-plugin';
 *
 * await publishIntegrationEvent(runtime, broker, orderPlaced, { orderId: '1' });
 * ```
 * @since 0.6.0
 */
export async function publishIntegrationEvent<T>(
  runtime: IRuntimeServices,
  broker: IMessageBroker,
  definition: IntegrationEventDefinition<T>,
  payload: T,
  metadata?: IntegrationEventMetadata,
  options?: PublishOptions,
): Promise<void> {
  // Envelope and effective options come from the ONE implementation the
  // outbox `write` shares (M107 §3.5): caller options validated once, then
  // the caller's key > the definition's selector > none (the selector is not
  // called when the caller supplied a key), and the caller's
  // `deduplicationId` or else the envelope id.
  const { envelope, options: effective } = await prepareIntegrationPublish(
    runtime,
    definition,
    payload,
    metadata,
    options,
  );

  await broker.publish(definition.topic, envelope, effective);
}

/**
 * Derives the causal metadata a consumed envelope contributes to the event
 * its handling publishes next — the whole of the chain-root rule, extracted
 * so no handler copies it by hand.
 *
 * @param envelope - The envelope being handled
 * @returns Metadata shaped to spread straight into
 *   {@linkcode publishIntegrationEvent}: the consumed envelope's
 *   `correlationId` (falling back to its own `id` — the chain-root rule) and
 *   its `id` as the direct cause
 * @example
 * ```typescript
 * import { causedBy, publishIntegrationEvent } from '@setu-ts/messaging-plugin';
 *
 * await publishIntegrationEvent(runtime, broker, orderCharged, { orderId: '1' }, {
 *   ...causedBy(envelope),
 * });
 * ```
 * @since 0.6.0
 */
export function causedBy(envelope: IntegrationEventEnvelope): {
  correlationId: string;
  causationId: string;
} {
  return {
    correlationId: envelope.correlationId ?? envelope.id,
    causationId: envelope.id,
  };
}
