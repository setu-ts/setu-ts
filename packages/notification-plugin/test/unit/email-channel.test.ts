/**
 * Tests for `EmailChannel` — address extraction + payload shaping.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IMailer, MailMessage, NotificationMessage } from '@setu-ts/common';
import { EmailChannel } from '../../src/channels/email-channel.ts';

describe('EmailChannel', () => {
  it('calls mailer.send with correct MailMessage shape', async () => {
    let captured: Parameters<IMailer['send']>[0] | undefined;
    const mailer: IMailer = {
      send: (msg: MailMessage) => {
        captured = msg;
        return Promise.resolve();
      },
      sendTemplate: () => Promise.resolve(),
    };
    const channel = new EmailChannel('email', mailer);
    const notification: NotificationMessage = {
      channels: ['email'],
      to: { email: 'user@example.com' },
      subject: 'Hello',
      body: 'Body text',
    };

    await channel.send(notification);

    expect(captured).toBeDefined();
    expect(captured!.to).toBe('user@example.com');
    expect(captured!.subject).toBe('Hello');
    expect(captured!.text).toBe('Body text');
    expect(channel.name).toBe('email');
  });

  it('uses default subject "(no subject)" when subject is absent', async () => {
    let captured: Parameters<IMailer['send']>[0] | undefined;
    const mailer: IMailer = {
      send: (msg: MailMessage) => {
        captured = msg;
        return Promise.resolve();
      },
      sendTemplate: () => Promise.resolve(),
    };
    const channel = new EmailChannel('email', mailer);
    const notification: NotificationMessage = {
      channels: ['email'],
      to: { email: 'user@example.com' },
      body: 'Body text',
    };

    await channel.send(notification);

    expect(captured!.subject).toBe('(no subject)');
  });

  it('throws when to.email is missing', async () => {
    const mailer: IMailer = {
      send: () => Promise.resolve(),
      sendTemplate: () => Promise.resolve(),
    };
    const channel = new EmailChannel('email', mailer);
    const notification: NotificationMessage = {
      channels: ['email'],
      to: {},
      body: 'Body text',
    };

    await expect(channel.send(notification)).rejects.toThrow(
      'Email channel requires "to.email"',
    );
  });
});
