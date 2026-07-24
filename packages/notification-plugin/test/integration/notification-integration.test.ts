/**
 * End-to-end integration: kernel app registers RuntimePlugin, a stub plugin providing
 * CAPABILITIES.MAIL (recording fake), and NotificationPlugin — then resolves INotifier,
 * calls send with multi-channel dispatch, reads back through fakes, and verifies health.
 *
 * @module
 */

// deno-lint-ignore-file no-explicit-any

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { HealthIndicatorFn, IRuntimeServices } from '@hono-enterprise/common';
import { NotificationPlugin } from '../../src/index.ts';
import { CAPABILITIES } from '@hono-enterprise/common';
import { createFakeMailer } from '../fixtures/fake-mailer.ts';
import { createFakeNotificationHttp } from '../fixtures/fake-notification-http.ts';

describe('notification-plugin integration', () => {
  it('registers INotifier, dispatches multi-channel send, and reports health', async () => {
    // Single shared service registry map.
    const serviceRegistry = new Map<string, unknown>();

    // Fake mailer for email channel.
    const capturedFakeMailer = createFakeMailer();
    serviceRegistry.set(CAPABILITIES.MAIL, capturedFakeMailer);

    // Fake HTTP for SMS and Slack channels.
    const smsFakeHttp = createFakeNotificationHttp({ responseBody: '{}', responseOk: true });
    const slackFakeHttp = createFakeNotificationHttp({ responseBody: 'ok', responseOk: true });

    // Build a minimal plugin context.
    const ctx = {
      services: {
        get(token: string): any {
          return serviceRegistry.get(token);
        },
        register(name: string, service: any): void {
          serviceRegistry.set(name, service);
        },
      },
      health: {
        register(name: string, fn: HealthIndicatorFn): void {
          if (name === 'notification') {
            // Capture health function so we can call it after registration.
            (ctx as any)._capturedHealthFn = fn;
          }
        },
      },
      lifecycle: {
        onClose: () => {},
        onRegister: () => {},
        onInit: () => {},
        onBootstrap: () => {},
        onRequest: () => {},
        onResponse: () => {},
        onShutdown: () => {},
        onError: () => {},
      },
      runtime: {} as IRuntimeServices,
      logger: undefined,
    };

    // Register notification plugin.
    const notificationOptions: import('../../src/interfaces/index.ts').NotificationPluginOptions = {
      channels: {
        email: { provider: 'mail' as const },
        sms: {
          provider: 'twilio' as const,
          options: {
            accountSid: 'AC123',
            authToken: 'authToken',
            from: '+19998887777',
            http: smsFakeHttp,
          },
        },
        slack: {
          provider: 'slack' as const,
          options: {
            webhookUrl: 'https://hooks.slack.com/webhook',
            http: slackFakeHttp,
          },
        },
      },
    };

    const notifPlugin = NotificationPlugin(notificationOptions);
    notifPlugin.register(ctx as any);

    // Resolve INotifier via our service registry.
    const notifier = serviceRegistry.get(CAPABILITIES.NOTIFICATION) as any;
    expect(notifier).toBeDefined();

    // Send notification on all three channels.
    await notifier.send({
      channels: ['email', 'sms', 'slack'],
      to: {
        email: 'user@example.com',
        phone: '+15554443333',
        token: 'device-token',
        channel: '#general',
      },
      subject: 'Test alert',
      body: 'Hello from notification plugin',
    });

    // Verify email channel: fake mailer received the message.
    expect(capturedFakeMailer.getLastMessage()).toBeDefined();
    const mailMsg = capturedFakeMailer.getLastMessage()!;
    expect(mailMsg.to).toBe('user@example.com');
    expect(mailMsg.subject).toBe('Test alert');
    expect(mailMsg.text).toBe('Hello from notification plugin');

    // Verify SMS channel: fake HTTP received the POST.
    const smsCall = smsFakeHttp.getLastCall();
    expect(smsCall).toBeDefined();
    expect(smsCall!.url).toContain('api.twilio.com');
    expect(smsCall!.body).toContain('To=%2B15554443333');

    // Verify Slack channel: fake HTTP received the POST.
    const slackCall = slackFakeHttp.getLastCall();
    expect(slackCall).toBeDefined();
    const slackBody = JSON.parse(slackCall!.body);
    expect(slackBody.text).toBe('Hello from notification plugin');
    expect(slackBody.channel).toBe('#general');

    // Verify health indicator.
    const capturedHealthFn = (ctx as any)._capturedHealthFn;
    expect(capturedHealthFn).toBeDefined();
    const healthResult = await capturedHealthFn();
    expect(healthResult.status).toBe('up');
    expect(healthResult.data).toBeDefined();
    const data = healthResult.data as Record<string, unknown>;
    expect(data.channels).toEqual(['email', 'sms', 'slack']);
  });

  it('fails fast when email channel configured without MailPlugin', () => {
    const ctx = {
      services: {
        get(): any {
          return undefined;
        },
        register(): void {},
      },
      health: { register: () => {} },
      lifecycle: {
        onClose: () => {},
        onRegister: () => {},
        onInit: () => {},
        onBootstrap: () => {},
        onRequest: () => {},
        onResponse: () => {},
        onShutdown: () => {},
        onError: () => {},
      },
      runtime: {} as IRuntimeServices,
      logger: undefined,
    };

    expect(() =>
      NotificationPlugin({
        channels: { email: { provider: 'mail' as const } },
      }).register(ctx as any)
    ).toThrow('Notification "email" channel requires the mail capability');
  });
});
