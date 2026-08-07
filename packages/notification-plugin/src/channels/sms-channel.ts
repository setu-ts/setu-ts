/**
 * SmsChannel — extracts phone address and dispatches via `SmsTransport`.
 *
 * @module
 */

import type { NotificationMessage } from '@setu-ts/common';
import type { NotificationChannel, SmsTransport } from '../interfaces/index.ts';

/**
 * `SmsChannel` dispatches notifications through an `SmsTransport` (e.g. `TwilioProvider`).
 *
 * @param name - The channel dispatch name
 * @param transport - The injected `SmsTransport`
 * @since 0.1.0
 */
export class SmsChannel implements NotificationChannel {
  readonly name: string;
  private readonly transport: SmsTransport;

  constructor(name: string, transport: SmsTransport) {
    this.name = name;
    this.transport = transport;
  }

  /**
   * Extracts `to.phone` and sends via `SmsTransport`.
   *
   * @param notification - The notification to send
   * @throws {Error} If `to.phone` is absent or transport rejects
   */
  async send(notification: NotificationMessage): Promise<void> {
    const phone = notification.to.phone;
    if (!phone) {
      throw new Error('SMS channel requires "to.phone"');
    }
    await this.transport.send({ to: phone, body: notification.body });
  }
}
