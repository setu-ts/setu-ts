/**
 * Integration-event contract definitions — the declarable, versioned shape a
 * cross-service event is published and consumed through.
 *
 * A definition is the single value both directions of the wire read: the
 * publisher takes its `type`/`version`/`topic`, and the consumer takes the
 * same three for validation plus the `parse` function that narrows the
 * delivered payload. The topic-suffix rule enforced here is the versioned
 * rollout policy made mechanical — a version bump with an unchanged topic
 * cannot be expressed.
 *
 * @module
 */

/**
 * A named, versioned cross-service event contract.
 *
 * Produced by {@linkcode defineIntegrationEvent}; read by
 * {@linkcode publishIntegrationEvent} and {@linkcode onIntegrationEvent}.
 *
 * @typeParam T - The event payload type the contract's parser produces
 * @since 0.6.0
 */
export interface IntegrationEventDefinition<T> {
  /** The event's semantic name, carried in the envelope's `type` field. */
  readonly type: string;
  /** The contract version. A bump is a breaking payload change. */
  readonly version: number;
  /** The transport topic the event is published to and consumed from. */
  readonly topic: string;
  /**
   * Narrows the delivered payload for the application handler. Runs on the
   * consumer side only — never on publish.
   */
  readonly parse: (value: unknown) => T;
}

/**
 * Defines a versioned integration-event contract and validates it eagerly.
 *
 * The versioned-topic rollout policy is enforced here rather than documented:
 * the `topic` must end with the exact string `.v${version}` (for example
 * `orders.placed.v2` for version `2`), so a version bump that leaves the topic
 * unchanged is refused at definition time — at module load, loudly — instead
 * of silently breaking every deployed consumer of the previous version. A
 * pre-existing topic that predates this policy has no versioned suffix by
 * design; keep using the raw `broker.publish`/`broker.subscribe` surface for
 * it, which this milestone does not change.
 *
 * @typeParam T - The event payload type `parse` produces
 * @param options - The contract's four fields
 * @returns The validated definition, with every field exposed unchanged
 * @throws {TypeError} When `type` or `topic` is empty, `version` is not a
 *   positive safe integer, `parse` is absent, or `topic` does not end with
 *   the exact `.v${version}` suffix
 * @example
 * ```typescript
 * import { defineIntegrationEvent } from '@setu-ts/messaging-plugin';
 *
 * const orderPlaced = defineIntegrationEvent<{ orderId: string }>({
 *   type: 'orders.placed',
 *   version: 1,
 *   topic: 'orders.placed.v1',
 *   parse: (value) => value as { orderId: string },
 * });
 * ```
 * @since 0.6.0
 */
export function defineIntegrationEvent<T>(options: {
  type: string;
  version: number;
  topic: string;
  parse: (value: unknown) => T;
}): IntegrationEventDefinition<T> {
  const { type, version, topic, parse } = options;
  if (typeof type !== 'string' || type.length === 0) {
    throw new TypeError(
      `defineIntegrationEvent: "type" must be a non-empty string; received ${String(type)}`,
    );
  }
  if (typeof topic !== 'string' || topic.length === 0) {
    throw new TypeError(
      `defineIntegrationEvent: "topic" must be a non-empty string; received ${String(topic)}`,
    );
  }
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new TypeError(
      `defineIntegrationEvent: "version" must be a positive safe integer; received ${
        String(version)
      }`,
    );
  }
  if (typeof parse !== 'function') {
    throw new TypeError('defineIntegrationEvent: "parse" must be a function');
  }
  const suffix = `.v${version}`;
  if (!topic.endsWith(suffix)) {
    throw new TypeError(
      `defineIntegrationEvent: "topic" must end with "${suffix}" to carry its own version ` +
        `(a version bump owns a distinct topic); received "${topic}"`,
    );
  }
  return { type, version, topic, parse };
}
