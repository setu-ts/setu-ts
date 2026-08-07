/**
 * PushChannel — extracts push token and dispatches via `PushTransport`.
 *
 * @module
 */

import type { NotificationMessage } from '@setu-ts/common';
import type { NotificationChannel, PushMessage, PushTransport } from '../interfaces/index.ts';

/**
 * `PushChannel` dispatches notifications through a `PushTransport` (e.g. `FcmProvider`).
 *
 * @param name - The channel dispatch name
 * @param transport - The injected `PushTransport`
 * @since 0.1.0
 */
export class PushChannel implements NotificationChannel {
  readonly name: string;
  private readonly transport: PushTransport;

  constructor(name: string, transport: PushTransport) {
    this.name = name;
    this.transport = transport;
  }

  /**
   * Extracts `to.token` and optionally `subject` as title, then sends via `PushTransport`.
   *
   * @param notification - The notification to send
   * @throws {Error} If `to.token` is absent or transport rejects
   */
  async send(notification: NotificationMessage): Promise<void> {
    const token = notification.to.token;
    if (!token) {
      throw new Error('Push channel requires "to.token"');
    }
    // Honor exactOptionalPropertyTypes — build without `title` when absent.
    const message: PushMessage = notification.subject === undefined
      ? { to: token, body: notification.body }
      : { to: token, title: notification.subject, body: notification.body };
    await this.transport.send(message);
  }
}
