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

  /**
   * Reports the mail transport's reachability by asking the injected
   * `IMailer`, which is the only channel in this package whose transport
   * offers a side-effect-free probe.
   *
   * `isHealthy` is optional on `IMailer`, so an injected mailer that does not
   * implement it — an application's own stub, or a `MailService` over a
   * provider with no probe — yields `undefined` rather than a guess.
   *
   * @returns `true` reachable, `false` contacted and unreachable, `undefined`
   * when the mailer cannot answer
   * @since 0.6.0
   */
  async isHealthy(): Promise<boolean | undefined> {
    if (typeof this.mailer.isHealthy !== 'function') {
      return undefined;
    }
    return await this.mailer.isHealthy();
  }
}
