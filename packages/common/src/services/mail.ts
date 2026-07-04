/**
 * Email contract, implemented by the MailPlugin's providers (SMTP, SES,
 * SendGrid, log) under `CAPABILITIES.MAIL`.
 *
 * @module
 */

/**
 * An outgoing email message.
 *
 * @since 0.1.0
 */
export interface MailMessage {
  /** Recipient address(es). */
  readonly to: string | readonly string[];
  /** Sender address; omitted to use the provider default. */
  readonly from?: string;
  /** Subject line. */
  readonly subject: string;
  /** HTML body. */
  readonly html?: string;
  /** Plain-text body. */
  readonly text?: string;
  /** Carbon-copy recipients. */
  readonly cc?: readonly string[];
  /** Blind-carbon-copy recipients. */
  readonly bcc?: readonly string[];
}

/**
 * Email sender.
 *
 * @example
 * ```typescript
 * const mailer = ctx.services.get<IMailer>(CAPABILITIES.MAIL);
 * await mailer.send({ to: user.email, subject: 'Welcome', text: 'Welcome!' });
 * ```
 * @since 0.1.0
 */
export interface IMailer {
  /**
   * Sends an email.
   *
   * @param message - The message to send
   * @throws {Error} If the provider rejects the message
   */
  send(message: MailMessage): Promise<void>;
  /**
   * Renders a named template and sends the result.
   *
   * @param template - Template name
   * @param message - Envelope (recipients, subject overrides)
   * @param data - Template variables
   * @throws {Error} If the template is unknown or the provider rejects the message
   */
  sendTemplate(
    template: string,
    message: Omit<MailMessage, 'html' | 'text'>,
    data: Readonly<Record<string, unknown>>,
  ): Promise<void>;
}
