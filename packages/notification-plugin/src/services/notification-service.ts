/**
 * `NotificationService` — the `INotifier` implementation with parallel fan-out and `AggregateError`.
 *
 * @module
 */

import type { ChannelSendResult, INotifier, NotificationMessage } from '@setu-ts/common';
import { serializeError } from '@setu-ts/common';
import type { NotificationChannel } from '../interfaces/index.ts';

/**
 * Coerces a rejection reason to an `Error`.
 *
 * @param reason - The rejection reason
 * @returns An `Error` instance
 * @since 0.1.0
 */
function toError(reason: unknown): Error {
  try {
    if (reason instanceof Error) {
      return reason;
    }
  } catch {
    // `instanceof` reads the left operand's prototype, and a revoked `Proxy`
    // throws from every internal method — so even the type test can reject out
    // of `sendSettled`, whose contract is that it never does. Fall through to
    // serialization, which is total.
  }
  // `serializeError` stringifies without throwing. `String(reason)` alone
  // throws for a value with no path to a primitive (a null-prototype object,
  // or one whose `toString` throws), which a channel is free to reject with —
  // and that throw would escape `sendSettled`, whose whole contract is that it
  // never rejects (M70f code review).
  return new Error(serializeError(reason).message);
}

/** One per-channel outcome carrying the original failure, before wrapping. */
interface ChannelOutcome {
  readonly channel: string;
  readonly ok: boolean;
  readonly error?: Error;
}

/**
 * Fans out a notification across every requested channel in parallel via
 * `Promise.allSettled`, recording one outcome per channel in request order and
 * **naming the channel on every failure** (X8-12).
 *
 * The channel name is held two lines above the site that used to discard it, so
 * attribution costs nothing: the resulting `AggregateError` (or `sendSettled`
 * result) names every failing channel without needing `.errors` to be rendered
 * in order.
 *
 * @param channels - The registered channel map
 * @param notification - The notification to fan out
 * @returns One outcome per requested channel, in request order
 */
async function dispatch(
  channels: Map<string, NotificationChannel>,
  notification: NotificationMessage,
): Promise<ChannelOutcome[]> {
  const results = await Promise.allSettled(
    notification.channels.map(async (name) => {
      const channel = channels.get(name);
      if (!channel) {
        throw new Error(`Unknown notification channel: ${name}`);
      }
      await channel.send(notification);
    }),
  );

  return results.map((result, index) => {
    const name = notification.channels[index]!;
    if (result.status === 'fulfilled') {
      return { channel: name, ok: true } as const;
    }
    return { channel: name, ok: false, error: toError(result.reason) } as const;
  });
}

/**
 * `NotificationService` implements `INotifier`, fanning out a single
 * `NotificationMessage` across all requested channels in parallel via
 * `Promise.allSettled`. If any channel fails, it throws an `AggregateError`
 * whose members **each name their channel** (X8-12).
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
   * @throws {AggregateError} If one or more channels fail — each member names
   *   its channel (`"channel '<name>' failed"`) and carries the original error
   *   on `cause`, so the failure is attributable without rendering `.errors`.
   */
  async send(notification: NotificationMessage): Promise<void> {
    if (notification.channels.length === 0) {
      return;
    }

    const outcomes = await dispatch(this.channels, notification);
    const errors = outcomes
      .filter((o): o is ChannelOutcome & { ok: false; error: Error } => !o.ok)
      // Wrap each rejection with the channel it came from (X8-12): the member
      // names its channel and the original error is preserved on `cause`.
      .map((o) => new Error(`channel '${o.channel}' failed`, { cause: o.error }));

    if (errors.length > 0) {
      throw new AggregateError(errors, 'One or more notification channels failed');
    }
  }

  /**
   * Dispatches a notification on every requested channel and reports the
   * settled outcome of each, without throwing.
   *
   * Unlike {@linkcode INotifier.send}, this never rejects: a failed channel is
   * reported as `{ channel, ok: false, error }` so a caller (typically one
   * behind a retrying queue) can retry the failing channel alone instead of
   * re-sending the whole notification. One result per requested channel, in
   * request order.
   *
   * @param notification - The notification to send
   * @returns One non-throwing result per requested channel, in request order
   * @since 0.1.0
   */
  async sendSettled(notification: NotificationMessage): Promise<readonly ChannelSendResult[]> {
    if (notification.channels.length === 0) {
      return [];
    }
    const outcomes = await dispatch(this.channels, notification);
    return outcomes.map((o): ChannelSendResult =>
      o.ok
        ? { channel: o.channel, ok: true }
        : { channel: o.channel, ok: false, error: serializeError(o.error) }
    );
  }
}
