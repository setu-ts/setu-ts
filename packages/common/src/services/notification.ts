/**
 * Multi-channel notification contract, fulfilled by the NotificationPlugin
 * under `CAPABILITIES.NOTIFICATION`.
 *
 * @module
 */

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
  /** Channel-specific extras. */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

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
}
