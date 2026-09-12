/**
 * The integration-event wire envelope, in both directions: the shape
 * {@linkcode createEnvelope} writes on publish and
 * {@linkcode validateEnvelope} checks before an application handler runs.
 *
 * Producer and consumer share one file so they cannot drift about what a
 * field is called or how it is checked. The envelope is payload data — the
 * whole `message` argument to `IMessageBroker.publish` — never transport
 * headers, because payload is the one channel every broker arm carries.
 *
 * @module
 */
import type { IRuntimeServices } from '@setu-ts/common';

import { IntegrationEventRejectedError } from '../errors.ts';
import type { IntegrationEventDefinition } from './definition.ts';
import type { IntegrationEventMetadata } from './publish.ts';

/**
 * The wire shape of a published integration event.
 *
 * `occurredAt` is an ISO-8601 **string**, not a `Date`: the in-memory broker's
 * `JsonSerializer` round-trips payloads through `JSON.parse`, so a `Date`
 * would arrive at the consumer as a string regardless of what the producer
 * put in — declaring the field a string is the honest type on every transport.
 * It is named `occurredAt` (not `occurredOn`, the `Date`-typed field the
 * events-plugin `DomainEvent` carries) so the two cannot be conflated.
 *
 * Unknown extra top-level fields are allowed by the consumer's structural
 * check, so an additive envelope change on a later framework version is not a
 * breaking deployment.
 *
 * @typeParam T - The payload type the consuming definition's parser produces
 * @since 0.6.0
 */
export interface IntegrationEventEnvelope<T = unknown> {
  /** Producer-assigned event identity (`runtime.uuid()`). */
  readonly id: string;
  /** The definition's semantic event name. */
  readonly type: string;
  /** The definition's contract version. */
  readonly version: number;
  /** Publish time as an ISO-8601 string (`new Date(runtime.now()).toISOString()`). */
  readonly occurredAt: string;
  /** The event payload, as the producer published it. */
  readonly data: T;
  /** ID of the chain root this event descends from, when propagated. */
  readonly correlationId?: string;
  /** ID of the event that directly caused this one, when propagated. */
  readonly causationId?: string;
  /** ID of the aggregate the event concerns, when supplied. */
  readonly aggregateId?: string;
  /** Version of the aggregate the event concerns, when supplied. */
  readonly aggregateVersion?: number;
}

/**
 * Builds the outgoing envelope. Internal — the only writer, so the producer
 * side cannot drift from the documented field set.
 *
 * Optional causal fields are **omitted** when their metadata member is absent,
 * never written as `undefined` (`exactOptionalPropertyTypes`).
 *
 * @internal
 * @param runtime - Runtime services supplying `uuid()` and `now()`
 * @param definition - The contract being published
 * @param payload - The caller's already-typed payload, carried verbatim
 * @param metadata - Optional causal metadata
 * @returns The envelope to publish
 */
export function createEnvelope<T>(
  runtime: IRuntimeServices,
  definition: IntegrationEventDefinition<T>,
  payload: T,
  metadata?: IntegrationEventMetadata,
): IntegrationEventEnvelope<T> {
  // `data` is mandatory on the wire, and `JSON.stringify` DROPS a key whose
  // value is `undefined` — so an `undefined` payload publishes cleanly and
  // then arrives with no `data` at all, which every consumer refuses as
  // malformed. On the default in-memory composition that refusal is reported
  // and dropped, so the event vanishes silently. Refuse at the producer, and
  // name the one-character remedy: a payloadless event carries `null`.
  if (payload === undefined) {
    throw new TypeError(
      `publishIntegrationEvent: "${definition.type}" payload is undefined, which JSON drops — ` +
        'a payloadless integration event must publish `null` instead',
    );
  }
  // A non-finite number serializes to `null`, so the consumer would receive an
  // aggregate version it cannot use while the producer believes it sent one.
  if (metadata?.aggregateVersion !== undefined && !Number.isFinite(metadata.aggregateVersion)) {
    throw new TypeError(
      `publishIntegrationEvent: "aggregateVersion" must be a finite number; received ${
        String(metadata.aggregateVersion)
      }`,
    );
  }
  return {
    id: runtime.uuid(),
    type: definition.type,
    version: definition.version,
    occurredAt: new Date(runtime.now()).toISOString(),
    data: payload,
    ...(metadata?.correlationId !== undefined ? { correlationId: metadata.correlationId } : {}),
    ...(metadata?.causationId !== undefined ? { causationId: metadata.causationId } : {}),
    ...(metadata?.aggregateId !== undefined ? { aggregateId: metadata.aggregateId } : {}),
    ...(metadata?.aggregateVersion !== undefined
      ? { aggregateVersion: metadata.aggregateVersion }
      : {}),
  };
}

/**
 * Builds the malformed-envelope refusal for one detail.
 * @internal
 */
function malformed(
  definition: IntegrationEventDefinition<unknown>,
  detail: string,
): IntegrationEventRejectedError {
  return new IntegrationEventRejectedError({
    reason: 'malformed',
    topic: definition.topic,
    expectedType: definition.type,
    expectedVersion: definition.version,
    detail,
  });
}

/**
 * Validates the delivered message structurally against the definition.
 * Internal — the only reader, so the consumer side cannot drift from the
 * documented check.
 *
 * Requires the mandatory fields to be present and of the right primitive type
 * (`id`/`type`/`occurredAt` strings, `version` a number, `data` present),
 * checks `type` and `version` for exact equality with the definition, and
 * IGNORES any additional top-level field it does not recognise — a producer on
 * a later framework version may add an envelope field this consumer's build
 * does not know about, and refusing it would make every additive envelope
 * change a coordinated deployment. Payload strictness is `parse`'s job, where
 * the application owns the policy.
 *
 * @internal
 * @param value - The message the broker delivered
 * @param definition - The contract the consumer subscribed with
 * @returns The validated envelope, typed over `unknown` data until parsed
 * @throws {IntegrationEventRejectedError} With reason `'malformed'` when the
 *   value is not an object or a mandatory field is missing or mistyped;
 *   `'type-mismatch'` when `type` differs from the definition; and
 *   `'version-mismatch'` when `version` differs from the definition
 */
export function validateEnvelope(
  value: unknown,
  definition: IntegrationEventDefinition<unknown>,
): IntegrationEventEnvelope<unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw malformed(definition, 'the delivered message is not a JSON object');
  }
  const envelope = value as Record<string, unknown>;
  if (envelope['id'] === undefined) {
    throw malformed(definition, 'the envelope is missing the "id" field');
  }
  if (typeof envelope['id'] !== 'string') {
    throw malformed(definition, 'the "id" field must be a string');
  }
  if (envelope['type'] === undefined) {
    throw malformed(definition, 'the envelope is missing the "type" field');
  }
  if (typeof envelope['type'] !== 'string') {
    throw malformed(definition, 'the "type" field must be a string');
  }
  if (envelope['version'] === undefined) {
    throw malformed(definition, 'the envelope is missing the "version" field');
  }
  if (typeof envelope['version'] !== 'number') {
    throw malformed(definition, 'the "version" field must be a number');
  }
  if (envelope['occurredAt'] === undefined) {
    throw malformed(definition, 'the envelope is missing the "occurredAt" field');
  }
  if (typeof envelope['occurredAt'] !== 'string') {
    throw malformed(definition, 'the "occurredAt" field must be a string');
  }
  if (Number.isNaN(Date.parse(envelope['occurredAt']))) {
    throw malformed(
      definition,
      `the "occurredAt" field is not an ISO-8601 instant: "${envelope['occurredAt']}"`,
    );
  }
  if (envelope['data'] === undefined) {
    throw malformed(definition, 'the envelope is missing the "data" field');
  }
  // The optional causal fields are typed `string`/`number` on
  // `IntegrationEventEnvelope`, and the consumer hands them to application code
  // (and to `causedBy`, which propagates `correlationId` into the NEXT event).
  // A foreign producer that sends the wrong primitive would otherwise make that
  // declared type a lie, one hop before it is copied onward.
  for (const field of ['correlationId', 'causationId', 'aggregateId'] as const) {
    if (envelope[field] !== undefined && typeof envelope[field] !== 'string') {
      throw malformed(definition, `the "${field}" field must be a string when present`);
    }
  }
  if (
    envelope['aggregateVersion'] !== undefined &&
    (typeof envelope['aggregateVersion'] !== 'number' ||
      !Number.isFinite(envelope['aggregateVersion']))
  ) {
    throw malformed(
      definition,
      'the "aggregateVersion" field must be a finite number when present',
    );
  }
  if (envelope['type'] !== definition.type) {
    throw new IntegrationEventRejectedError({
      reason: 'type-mismatch',
      topic: definition.topic,
      expectedType: definition.type,
      expectedVersion: definition.version,
      detail: `the envelope declares type "${envelope['type']}"`,
    });
  }
  if (envelope['version'] !== definition.version) {
    throw new IntegrationEventRejectedError({
      reason: 'version-mismatch',
      topic: definition.topic,
      expectedType: definition.type,
      expectedVersion: definition.version,
      detail: `the envelope declares version ${envelope['version']}`,
    });
  }
  return envelope as unknown as IntegrationEventEnvelope<unknown>;
}
