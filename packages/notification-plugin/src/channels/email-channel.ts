/**
 * EmailChannel — builds a `MailMessage` from a `NotificationMessage` and delegates to `IMailer`.
 *
 * @module
 */

import type { IMailer, NotificationMessage } from '@setu-ts/common';
import type { NotificationChannel } from '../interfaces/index.ts';

/**
 * `EmailChannel` dispatches notifications through the resolved `IMailer`.
 *
 * @param name - The channel dispatch name
 * @param mailer - The injected `IMailer` (typically from M29's MailPlugin)
 * @since 0.1.0
 */
export class EmailChannel implements NotificationChannel {
  readonly name: string;
  private readonly mailer: IMailer;

  constructor(name: string, mailer: IMailer) {
    this.name = name;
    this.mailer = mailer;
  }

  /**
   * Builds a `MailMessage` and sends it via `IMailer`.
   *
   * @param notification - The notification to send
   * @throws {Error} If `to.email` is absent or mailer rejects
   */
  async send(notification: NotificationMessage): Promise<void> {
    const email = notification.to.email;
    if (!email) {
      throw new Error('Email channel requires "to.email"');
    }
    await this.mailer.send({
      to: email,
      subject: notification.subject ?? '(no subject)',
      text: notification.body,
    });
  }
}
