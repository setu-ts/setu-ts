/**
 * End-to-end integration through a REAL kernel app: `createApplication` registers
 * `RuntimePlugin`, a stub plugin providing `CAPABILITIES.MAIL` (recording fake
 * `IMailer`), and `NotificationPlugin`. The notifier is resolved from the live
 * service registry, driven from an HTTP route via `app.inject()`, and every write
 * is read back through the fakes.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES } from '@hono-enterprise/common';
import type {
  IHealthIndicator,
  IMailer,
  INotifier,
  IPlugin,
  IPluginContext,
  MailMessage,
} from '@hono-enterprise/common';
import { createApplication } from '@hono-enterprise/kernel';
import { RuntimePlugin } from '@hono-enterprise/runtime';
import { NotificationPlugin } from '../../src/index.ts';
import { createFakeNotificationHttp } from '../fixtures/fake-notification-http.ts';

/** Stub plugin standing in for M29's MailPlugin — provides `CAPABILITIES.MAIL` only. */
function MailStubPlugin(sent: MailMessage[]): IPlugin {
  return {
    name: 'mail-stub-plugin',
    version: '0.1.0',
    provides: [CAPABILITIES.MAIL],
    register(ctx: IPluginContext): void {
      const mailer: IMailer = {
        send(message: MailMessage): Promise<void> {
          sent.push(message);
          return Promise.resolve();
        },
        sendTemplate(): Promise<void> {
          return Promise.reject(new Error('sendTemplate is not used by the email channel'));
        },
      };
      ctx.services.register<IMailer>(CAPABILITIES.MAIL, mailer);
    },
  };
}

describe('notification-plugin integration (through a real kernel app)', () => {
  it('dispatches every channel, reports health, and is reachable from a route', async () => {
    const sent: MailMessage[] = [];
    const smsHttp = createFakeNotificationHttp({ responseBody: '{"sid":"SM1"}' });
    const pushHttp = createFakeNotificationHttp({ responseBody: '{"success":1}' });
    const slackHttp = createFakeNotificationHttp({ responseBody: 'ok' });

    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        MailStubPlugin(sent),
        NotificationPlugin({
          channels: {
            email: { provider: 'mail' },
            sms: {
              provider: 'twilio',
              options: {
                accountSid: 'AC_test',
                authToken: 'tok',
                from: '+15550000000',
                http: smsHttp,
              },
            },
            push: {
              provider: 'fcm',
              options: {
                projectId: 'my-project',
                // A stub token source keeps this test on the send path; the
                // real RS256 signing is covered in the token-source unit tests.
                tokenSource: {
                  getAccessToken: (): Promise<string> => Promise.resolve('ya29.test-token'),
                },
                http: pushHttp,
              },
            },
            slack: {
              provider: 'slack',
              options: { webhookUrl: 'https://hooks.slack.com/services/T/B/X', http: slackHttp },
            },
          },
        }),
      ],
    });

    app.router.post('/orders', async (ctx) => {
      const notifier = ctx.services.get<INotifier>(CAPABILITIES.NOTIFICATION);
      await notifier.send({
        channels: ['email', 'sms', 'push', 'slack'],
        to: {
          email: 'user@example.com',
          phone: '+15554443333',
          token: 'device-token-1',
          channel: '#orders',
        },
        subject: 'Order Confirmed',
        body: 'Your order 42 has been confirmed.',
      });
      return ctx.response.status(201).json({ ok: true });
    });

    await app.start();

    const res = await app.inject({ method: 'POST', url: 'http://localhost/orders' });
    expect(res.statusCode).toBe(201);
    expect(res.json<{ ok: boolean }>()).toEqual({ ok: true });

    // Email — read back through the stub mailer registered by another plugin.
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      to: 'user@example.com',
      subject: 'Order Confirmed',
      text: 'Your order 42 has been confirmed.',
    });

    // SMS — Twilio form-encoded POST with Basic auth.
    const smsCall = smsHttp.getLastCall();
    expect(smsCall?.url).toBe(
      'https://api.twilio.com/2010-04-01/Accounts/AC_test/Messages.json',
    );
    expect(smsCall?.body).toBe(
      'To=%2B15554443333&From=%2B15550000000&Body=Your+order+42+has+been+confirmed.',
    );
    expect(smsCall?.headers['Authorization']).toBe(`Basic ${btoa('AC_test:tok')}`);
    expect(smsCall?.headers['Content-Type']).toBe('application/x-www-form-urlencoded');

    // Push — FCM HTTP v1 POST, bearer-authenticated and project-addressed.
    const pushCall = pushHttp.getLastCall();
    expect(pushCall?.url).toBe('https://fcm.googleapis.com/v1/projects/my-project/messages:send');
    expect(JSON.parse(pushCall!.body)).toEqual({
      message: {
        token: 'device-token-1',
        notification: { body: 'Your order 42 has been confirmed.', title: 'Order Confirmed' },
      },
    });
    expect(pushCall?.headers['Authorization']).toBe('Bearer ya29.test-token');

    // Slack — incoming-webhook JSON POST.
    const slackCall = slackHttp.getLastCall();
    expect(slackCall?.url).toBe('https://hooks.slack.com/services/T/B/X');
    expect(JSON.parse(slackCall!.body)).toEqual({
      text: 'Your order 42 has been confirmed.',
      channel: '#orders',
    });

    // Health indicator, resolved the way the health plugin resolves it.
    const indicators = app.services.getAll<IHealthIndicator>(CAPABILITIES.HEALTH_INDICATOR);
    const notification = indicators.find((i) => i.name === 'notification');
    expect(notification).toBeDefined();
    expect(await notification!.check()).toEqual({
      status: 'up',
      data: { channels: ['email', 'sms', 'push', 'slack'] },
    });

    await app.stop();
  });

  it('resolves the mail capability even when MailPlugin is registered later', async () => {
    const sent: MailMessage[] = [];
    // NotificationPlugin is listed FIRST; the `mail` optionalDependencies edge
    // must still order the mail provider ahead of it.
    const app = createApplication({
      plugins: [
        NotificationPlugin({ channels: { email: { provider: 'mail' } } }),
        MailStubPlugin(sent),
        RuntimePlugin(),
      ],
    });
    await app.start();

    const notifier = app.services.get<INotifier>(CAPABILITIES.NOTIFICATION);
    await notifier.send({
      channels: ['email'],
      to: { email: 'late@example.com' },
      body: 'no subject here',
    });
    // Default subject applied for a NotificationMessage with no `subject`.
    expect(sent[0]).toEqual({
      to: 'late@example.com',
      subject: '(no subject)',
      text: 'no subject here',
    });

    await app.stop();
  });

  it('aggregates per-channel failures without aborting the healthy channels', async () => {
    const sent: MailMessage[] = [];
    // Slack replies 400 — the whole send must still deliver email and report both errors.
    const slackHttp = createFakeNotificationHttp({
      responseOk: false,
      responseStatus: 400,
      responseBody: 'invalid_payload',
    });

    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        MailStubPlugin(sent),
        NotificationPlugin({
          channels: {
            email: { provider: 'mail' },
            slack: {
              provider: 'slack',
              options: { webhookUrl: 'https://hooks/x', http: slackHttp },
            },
          },
        }),
      ],
    });
    await app.start();

    const notifier = app.services.get<INotifier>(CAPABILITIES.NOTIFICATION);
    let caught: unknown;
    try {
      await notifier.send({
        channels: ['email', 'nonexistent', 'slack'],
        to: { email: 'user@example.com' },
        subject: 'Hi',
        body: 'body',
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AggregateError);
    const agg = caught as AggregateError;
    expect(agg.message).toBe('One or more notification channels failed');
    expect(agg.errors.every((e: unknown) => e instanceof Error)).toBe(true);
    expect((agg.errors as Error[]).map((e) => e.message)).toEqual([
      'Unknown notification channel: nonexistent',
      'Slack webhook error (400)',
    ]);
    // The healthy channel still delivered.
    expect(sent).toHaveLength(1);

    await app.stop();
  });

  it('fails app startup when an email channel is configured without any mail provider', async () => {
    const app = createApplication({
      plugins: [RuntimePlugin(), NotificationPlugin({ channels: { email: { provider: 'mail' } } })],
    });
    let caught: unknown;
    try {
      await app.start();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain(
      'Notification "email" channel requires the mail capability',
    );
  });
});
