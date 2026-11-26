/** Independent subscription names and the portable fan-out contract. @module */
import type { ISubscription, SubscribeOptions } from '@setu-ts/common';

/**
 * Validates the mutually exclusive delivery modes.
 * @param options - Subscription options
 * @returns Whether independent delivery was requested
 * @throws {RangeError} When fanOut and queue are combined
 * @since 0.14.0
 */
export function wantsFanOut(options: SubscribeOptions | undefined): boolean {
  if (options?.fanOut !== true) return false;
  if (options.queue !== undefined)
    throw new RangeError('SubscribeOptions.fanOut cannot be combined with queue');
  return true;
}

/**
 * Marks an independently delivered subscription without wrapping its lifecycle.
 * @param subscription - The active handle
 * @param independent - Whether the broker established independent delivery
 * @returns The handle with its optional confirmation marker
 * @throws Never
 * @since 0.14.0
 */
export function markFanOut(subscription: ISubscription, independent: boolean): ISubscription {
  return independent ? { ...subscription, fanOut: true } : subscription;
}

/**
 * Creates a per-instance consumer name.
 * @param prefix - Configured consumer prefix
 * @param id - Runtime UUID
 * @param serviceBus - Whether to fit Service Bus's 50-character limit
 * @returns A unique consumer name
 * @throws Never
 * @since 0.14.0
 */
export function fanOutName(prefix: string, id: string, serviceBus = false): string {
  if (!serviceBus) return `${prefix}-fanout-${id}`;
  const owner = prefix.slice(0, 30).replace(/^[-._]+|[-._]+$/gu, '') || 'messaging';
  return `${owner}-fanout-${id.replaceAll('-', '').slice(0, 12)}`;
}

/** A classified Service Bus entity-name collision, never a generic conflict. @since 0.14.0 */
export class SubscriptionNameExistsError extends Error {
  /**
   * @param cause - The SDK's classified RestError
   * @returns The collision error
   * @throws Never
   * @since 0.14.0
   */
  constructor(cause: unknown) {
    super('Service Bus subscription name already exists', { cause });
    this.name = 'SubscriptionNameExistsError';
  }
}
