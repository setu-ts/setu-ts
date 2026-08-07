/**
 * Recording `IMailer` capturing the last `MailMessage` for email-channel and integration tests.
 *
 * @module
 */

import type { IMailer, MailMessage } from '@setu-ts/common';

/**
 * Creates a fake `IMailer` that records sent messages.
 *
 * @returns The fake mailer
 * @since 0.1.0
 */
export function createFakeMailer(): IMailer & {
  getLastMessage(): MailMessage | undefined;
  reset(): void;
} {
  let lastMessage: MailMessage | undefined;

  return {
    send(message: MailMessage): Promise<void> {
      lastMessage = message;
      return Promise.resolve();
    },
    sendTemplate(): Promise<void> {
      return Promise.resolve();
    },
    getLastMessage(): typeof lastMessage {
      return lastMessage;
    },
    reset(): void {
      lastMessage = undefined;
    },
  };
}
