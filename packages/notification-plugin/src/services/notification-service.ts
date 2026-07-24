/**
 * `NotificationService` — the `INotifier` implementation with parallel fan-out and `AggregateError`.
 *
 * @module
 */

import type { INotifier, NotificationMessage } from '@hono-enterprise/common';
import type { NotificationChannel } from '../interfaces/index.ts';

/**
 * Coerces a rejection reason to an `Error`.
 *
 * @param reason - The rejection reason
 * @returns An `Error` instance
 * @since 0.1.0
 */
function toError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}

/**
 * `NotificationService` implements `INotifier`, fanning out a single
 * `NotificationMessage` across all requested channels in parallel via
 * `Promise.allSettled`. If any channel fails, it throws an `AggregateError`
 * containing every per-channel error.
 *
 * @since 0.1.0
 */
export class NotificationService implements INotifier {
  private readonly channels: Map<string, NotificationChannel>;

  /**
   * Creates a `NotificationService` with the given channel map.
   *
   * @param channels - Map of channel name to channel instance
   */
  constructor(channels: Map<string, NotificationChannel>) {
    this.channels = channels;
  }

  /**
   * Dispatches a notification on every requested channel.
   *
   * @param notification - The notification to send
   * @throws {AggregateError} If one or more channels fail
   */
  async send(notification: NotificationMessage): Promise<void> {
    if (notification.channels.length === 0) {
      return;
    }

    const results = await Promise.allSettled(
      notification.channels.map(async (name) => {
        const channel = this.channels.get(name);
        if (!channel) {
          throw new Error(`Unknown notification channel: ${name}`);
        }
        await channel.send(notification);
      }),
    );

    const errors: Error[] = [];
    for (const result of results) {
      if (result.status === 'rejected') {
        errors.push(toError(result.reason));
      }
    }

    if (errors.length > 0) {
      throw new AggregateError(errors, 'One or more notification channels failed');
    }
  }
}
