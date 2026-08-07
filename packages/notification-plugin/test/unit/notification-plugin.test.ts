/**
 * Tests for `NotificationPlugin`, `createChannel`, and `createProvider`.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES, PLUGIN_PRIORITY } from '@setu-ts/common';
import type { INotifier } from '@setu-ts/common';
import {
  createChannel,
  createProvider,
  EmailChannel,
  FcmProvider,
  NotificationPlugin,
  PushChannel,
  SlackChannel,
  SlackProvider,
  SmsChannel,
  TwilioProvider,
} from '../../src/index.ts';
import type { ChannelConfig } from '../../src/index.ts';
import { createFakeMailer } from '../fixtures/fake-mailer.ts';
import { createFakeNotificationHttp } from '../fixtures/fake-notification-http.ts';
import { createFakeContext } from '../fixtures/fake-context.ts';

const twilioConfig: ChannelConfig = {
  provider: 'twilio',
  options: { accountSid: 'AC1', authToken: 'tok', from: '+15550000000' },
};
/** Stub token source so plugin tests exercise wiring, not RSA signing. */
const stubTokenSource = {
  getAccessToken: (): Promise<string> => Promise.resolve('ya29.test-token'),
};
const fcmConfig: ChannelConfig = {
  provider: 'fcm',
  options: { projectId: 'my-project', tokenSource: stubTokenSource },
};
const slackConfig: ChannelConfig = {
  provider: 'slack',
  options: { webhookUrl: 'https://hooks.slack.com/services/T/B/X' },
};

describe('NotificationPlugin metadata', () => {
  it('exposes the expected plugin contract fields', () => {
    const plugin = NotificationPlugin({ channels: {} });
    expect(plugin.name).toBe('notification-plugin');
    expect(plugin.version).toBe('0.1.0');
    expect(plugin.provides).toEqual([CAPABILITIES.NOTIFICATION]);
    expect(plugin.priority).toBe(PLUGIN_PRIORITY.NORMAL);
    // `mail` only — the plugin never reads a logger, so it declares no logger edge.
    expect(plugin.optionalDependencies).toEqual([CAPABILITIES.MAIL]);
  });
});

describe('NotificationPlugin.register', () => {
  it('registers a working INotifier and a healthy indicator listing the channels', async () => {
    const fakeMailer = createFakeMailer();
    const fakeHttp = createFakeNotificationHttp({ responseBody: 'ok' });
    const fake = createFakeContext({ [CAPABILITIES.MAIL]: fakeMailer });

    NotificationPlugin({
      channels: {
        email: { provider: 'mail' },
        slack: { provider: 'slack', options: { webhookUrl: 'https://hooks/x', http: fakeHttp } },
      },
    }).register(fake.ctx);

    // Capability resolves to a service that actually dispatches.
    const notifier = fake.registered.get(CAPABILITIES.NOTIFICATION) as INotifier;
    await notifier.send({
      channels: ['email', 'slack'],
      to: { email: 'u@example.com', channel: '#ops' },
      subject: 'Hi',
      body: 'body text',
    });
    expect(fakeMailer.getLastMessage()?.to).toBe('u@example.com');
    expect(JSON.parse(fakeHttp.getLastCall()!.body).channel).toBe('#ops');

    // Health indicator reports up with the configured channel names.
    const indicator = fake.healthIndicators.get('notification');
    expect(indicator).toBeDefined();
    const result = await indicator!();
    expect(result.status).toBe('up');
    expect(result.data).toEqual({ channels: ['email', 'slack'] });
  });

  it('registers an empty channel map without touching the mail capability', () => {
    const fake = createFakeContext();
    NotificationPlugin({ channels: {} }).register(fake.ctx);
    expect(fake.registered.has(CAPABILITIES.NOTIFICATION)).toBe(true);
    expect(fake.healthIndicators.has('notification')).toBe(true);
  });

  it('fails fast when an email channel is configured without the mail capability', () => {
    const fake = createFakeContext();
    expect(() =>
      NotificationPlugin({ channels: { email: { provider: 'mail' } } }).register(fake.ctx)
    ).toThrow('Notification "email" channel requires the mail capability');
  });
});

describe('createProvider', () => {
  it('resolves the registered IMailer for a mail config', () => {
    const fakeMailer = createFakeMailer();
    const fake = createFakeContext({ [CAPABILITIES.MAIL]: fakeMailer });
    expect(createProvider({ provider: 'mail' }, fake.ctx)).toBe(fakeMailer);
  });

  it('throws for a mail config with no context at all', () => {
    expect(() => createProvider({ provider: 'mail' })).toThrow(
      'Notification "email" channel requires the mail capability',
    );
  });

  it('throws for a mail config when the mail capability is absent', () => {
    const fake = createFakeContext();
    expect(() => createProvider({ provider: 'mail' }, fake.ctx)).toThrow(
      'Notification "email" channel requires the mail capability',
    );
  });

  it('builds the matching provider for each transport config', () => {
    expect(createProvider(twilioConfig)).toBeInstanceOf(TwilioProvider);
    expect(createProvider(fcmConfig)).toBeInstanceOf(FcmProvider);
    expect(createProvider(slackConfig)).toBeInstanceOf(SlackProvider);
  });

  it('builds an fcm provider from the runtime capability when no tokenSource is given', () => {
    const fake = createFakeContext();
    const provider = createProvider({
      provider: 'fcm',
      options: {
        projectId: 'p',
        clientEmail: 'a@b.iam.gserviceaccount.com',
        privateKey: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----',
      },
    }, fake.ctx);
    expect(provider).toBeInstanceOf(FcmProvider);
  });

  it('throws at registration when a service-account fcm channel has no runtime', () => {
    // Failing here rather than on the first notification means a misconfigured
    // push channel is caught while the app is starting, not in production.
    expect(() =>
      createProvider({
        provider: 'fcm',
        options: {
          projectId: 'p',
          clientEmail: 'a@b.iam.gserviceaccount.com',
          privateKey: 'pem',
        },
      })
    ).toThrow('requires the runtime capability');
  });

  it('accepts an fcm channel with an explicit tokenSource and no runtime', () => {
    // A caller-supplied token source carries its own credentials, so the
    // runtime requirement must not apply to it.
    expect(createProvider(fcmConfig)).toBeInstanceOf(FcmProvider);
  });

  it('passes an injected http seam through to the provider', async () => {
    const fakeHttp = createFakeNotificationHttp({ responseBody: 'ok' });
    const provider = createProvider({
      provider: 'slack',
      options: { webhookUrl: 'https://hooks/y', http: fakeHttp },
    });
    await provider.send({ text: 'hello' });
    expect(fakeHttp.getLastCall()?.url).toBe('https://hooks/y');
  });

  it('throws for an unsupported provider type', () => {
    expect(() => createProvider({ provider: 'carrier-pigeon' } as unknown as ChannelConfig))
      .toThrow(
        'Unsupported notification provider: carrier-pigeon',
      );
  });
});

describe('createChannel', () => {
  it('returns an EmailChannel for a mail config', () => {
    const fake = createFakeContext({ [CAPABILITIES.MAIL]: createFakeMailer() });
    const channel = createChannel('my-email', { provider: 'mail' }, fake.ctx);
    expect(channel).toBeInstanceOf(EmailChannel);
    expect(channel.name).toBe('my-email');
  });

  it('returns an SmsChannel for a twilio config', () => {
    const channel = createChannel('my-sms', twilioConfig);
    expect(channel).toBeInstanceOf(SmsChannel);
    expect(channel.name).toBe('my-sms');
  });

  it('returns a PushChannel for an fcm config', () => {
    const channel = createChannel('my-push', fcmConfig);
    expect(channel).toBeInstanceOf(PushChannel);
    expect(channel.name).toBe('my-push');
  });

  it('returns a SlackChannel for a slack config', () => {
    const channel = createChannel('my-slack', slackConfig);
    expect(channel).toBeInstanceOf(SlackChannel);
    expect(channel.name).toBe('my-slack');
  });

  it('throws for an unsupported provider type', () => {
    expect(() => createChannel('x', { provider: 'bogus' } as unknown as ChannelConfig)).toThrow(
      'Unsupported notification provider: bogus',
    );
  });
});
