/**
 * Multi-channel notification contract, fulfilled by the NotificationPlugin
 * under `CAPABILITIES.NOTIFICATION`.
 *
 * @module
 */
import type { SerializedError } from '../errors/serialize-error.ts';

/**
 * A notification dispatched across one or more channels.
 *
 * @since 0.1.0
 */
export interface NotificationMessage {
  /** Channel names to dispatch on (e.g. `['email', 'sms']`). */
  readonly channels: readonly string[];
  /** Recipient addresses keyed by channel (e.g. `{ email: '…', phone: '…' }`). */
  readonly to: Readonly<Record<string, string>>;
  /** Subject/title, for channels that support one. */
  readonly subject?: string;
  /** Notification body. */
  readonly body: string;
  /**
   * Channel-specific extras.
   *
   * The four built-in channels (email, sms, push, slack) accept these but do
   * not read them; they exist for custom channel implementations registered
   * alongside the built-ins.
   */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * The settled outcome of dispatching a notification on a single channel.
 *
 * One element is returned per requested channel, in request order, by
 * {@linkcode INotifier.sendSettled}. A channel that failed reports `ok: false`
 * with the serialized error rather than throwing, so a caller can retry one
 * channel without re-sending the ones that succeeded.
 *
 * @since 0.1.0
 */
export type ChannelSendResult =
  | { readonly channel: string; readonly ok: true }
  | { readonly channel: string; readonly ok: false; readonly error: SerializedError };

/**
 * Multi-channel notification dispatcher.
 *
 * @example
 * ```typescript
 * const notifier = ctx.services.get<INotifier>(CAPABILITIES.NOTIFICATION);
 * await notifier.send({
 *   channels: ['email', 'sms'],
 *   to: { email: user.email, phone: user.phone },
 *   subject: 'Order shipped',
 *   body: 'Your order is on its way.',
 * });
 * ```
 * @since 0.1.0
 */
export interface INotifier {
  /**
   * Dispatches a notification on every requested channel.
   *
   * @param notification - The notification to send
   * @throws {AggregateError} If one or more channels fail
   */
  send(notification: NotificationMessage): Promise<void>;
  /**
   * Dispatches a notification on every requested channel and reports the
   * settled outcome of each, without throwing.
   *
   * Unlike {@linkcode INotifier.send}, this never rejects: a failed channel is
   * reported as `{ channel, ok: false, error }` rather than raised, so a caller
   * (typically one behind a retrying queue) can retry the failing channel alone
   * instead of re-sending the whole notification. An unknown channel name is
   * reported as `ok: false`, matching `send`'s existing treatment of it as a
   * failure.
   *
   * Optional on the contract so existing implementors are not broken; resolve
   * it with `?.` and fall back to {@linkcode INotifier.send} when absent.
   *
   * @param notification - The notification to send
   * @returns One non-throwing result per requested channel, in request order
   * @since 0.1.0
   */
  sendSettled?(notification: NotificationMessage): Promise<readonly ChannelSendResult[]>;
}
