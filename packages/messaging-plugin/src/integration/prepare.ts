/**
 * The ONE implementation of an integration event's envelope and effective
 * publish options, shared by `publishIntegrationEvent` and the outbox `write`
 * (M107 §3.5).
 *
 * Both entry points must agree on the ordering-key precedence and on the
 * de-duplication rule, so neither re-derives them: a caller's
 * `deduplicationId` reaches the broker through the outbox exactly as it does
 * through a direct publish.
 *
 * @module
 */
import type { IRuntimeServices, ParsedPublishOptions, PublishOptions } from '@setu-ts/common';

import { validatePublishOptions } from '../brokers/publish-options.ts';
import type { IntegrationEventDefinition } from './definition.ts';
import type { IntegrationEventEnvelope } from './envelope.ts';
import { createEnvelope } from './envelope.ts';
import type { IntegrationEventMetadata } from './publish.ts';

/**
 * An envelope and the effective options it is published with.
 *
 * @internal
 */
export interface PreparedIntegrationPublish<T> {
  /** The envelope, built once; its `id` is the default de-duplication id. */
  readonly envelope: IntegrationEventEnvelope<T>;
  /**
   * The validated, frozen effective options: the resolved ordering key (when
   * any), the de-duplication id (always present), and the caller's headers.
   */
  readonly options: ParsedPublishOptions;
}

/**
 * Builds the envelope and resolves the effective publish options.
 *
 * The caller's options are validated once (copy-once) and only the copy is
 * read afterwards. Precedence (M106 §3.7): the caller's `orderingKey`, then the
 * definition's selector, then none — the selector is not called when the
 * caller supplied a key. The de-duplication id is the caller's, else the
 * envelope id. The effective object is validated again, which is what subjects
 * a selector's value to the id rules.
 *
 * @internal
 * @typeParam T - The event payload type
 * @param runtime - Runtime services supplying `uuid()` and `now()`
 * @param definition - The contract being published
 * @param payload - The event payload, carried verbatim
 * @param metadata - Optional causal metadata
 * @param options - Optional caller publish options
 * @returns The envelope and effective options
 * @throws {RangeError} As a rejected promise when the options (or the
 *   selector's value) fail validation
 * @throws {TypeError} As a rejected promise when the envelope cannot be built
 */
export async function prepareIntegrationPublish<T>(
  runtime: IRuntimeServices,
  definition: IntegrationEventDefinition<T>,
  payload: T,
  metadata?: IntegrationEventMetadata,
  options?: PublishOptions,
): Promise<PreparedIntegrationPublish<T>> {
  const validated = await validatePublishOptions(options);
  const envelope = createEnvelope(runtime, definition, payload, metadata);
  const orderingKey = validated.orderingKey ?? definition.orderingKey?.(envelope);
  const effective = await validatePublishOptions({
    ...(orderingKey !== undefined ? { orderingKey } : {}),
    deduplicationId: validated.deduplicationId ?? envelope.id,
    headers: validated.headers,
  });
  return { envelope, options: effective };
}
