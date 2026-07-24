/**
 * Tests for `NotificationPlugin`, `createChannel`, and `createProvider`.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  createChannel,
  createProvider,
  FcmProvider,
  NotificationPlugin,
  SlackProvider,
  TwilioProvider,
} from '../../src/plugin/notification-plugin.ts';
import type { IPluginContext } from '@hono-enterprise/common';
import { CAPABILITIES } from '@hono-enterprise/common';
import { createFakeMailer } from '../fixtures/fake-mailer.ts';
import { createFakeNotificationHttp } from '../fixtures/fake-notification-http.ts';

describe('NotificationPlugin', () => {
  it('creates the plugin with correct metadata', () => {
    const plugin = NotificationPlugin({ channels: {} });
    expect(plugin.name).toBe('notification-plugin');
    expect(plugin.version).toBe('0.1.0');
    expect(plugin.provides).toEqual([CAPABILITIES.NOTIFICATION]);
    expect(plugin.priority).toBe(500);
    expect(plugin.optionalDependencies).toEqual([CAPABILITIES.MAIL, CAPABILITIES.LOGGER]);
  });

  it('registers INotifier and health indicator', () => {
    const registeredServices = new Map<string, unknown>();
    const registeredHealth = new Map<string, unknown>();
    const ctx = {
      // deno-lint-ignore no-explicit-any
      services: {
        get(s: string): any {
          return registeredServices.get(s);
        },
        register(_name: string, _service: unknown): void {
          registeredServices.set(_name, _service as unknown);
        },
      },
      health: {
        register: (name: string, fn: () => Promise<{ status: string }>): void => {
          registeredHealth.set(name, fn);
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
      runtime: {},
    } as unknown as IPluginContext;

    const plugin = NotificationPlugin({ channels: {} });
    plugin.register(ctx);

    expect(registeredServices.has(CAPABILITIES.NOTIFICATION)).toBe(true);
    expect(registeredHealth.has('notification')).toBe(true);
  });
});

describe('createProvider', () => {
  it("returns IMailer for 'mail'", () => {
    const fakeMailer = createFakeMailer();
    const ctx = {
      services: {
        // deno-lint-ignore no-explicit-any
        get(_s: string): any {
          return fakeMailer;
        },
        // deno-lint-ignore no-empty-function
        register(_name: string, _service: unknown): void {},
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
      runtime: {},
    } as unknown as IPluginContext;

    const result = createProvider('mail', {}, ctx);
    expect(result).toBe(fakeMailer);
  });

  it('throws for mail without context', () => {
    // deno-lint-ignore no-explicit-any
    expect(() => createProvider('mail', {} as any)).toThrow(
      'Notification "email" channel requires the mail capability',
    );
  });

  it('returns TwilioProvider for twilio', () => {
    const fakeHttp = createFakeNotificationHttp();
    const result = createProvider('twilio', {
      accountSid: 'A',
      authToken: 't',
      from: '+1',
      http: fakeHttp,
    });
    expect(result).toBeInstanceOf(TwilioProvider);
  });

  it('TwilioProvider uses default http when http is not provided', () => {
    const result = createProvider('twilio', { accountSid: 'A', authToken: 't', from: '+1' });
    expect(result).toBeInstanceOf(TwilioProvider);
  });

  it('returns FcmProvider for fcm', () => {
    const fakeHttp = createFakeNotificationHttp();
    const result = createProvider('fcm', { serverKey: 'key', http: fakeHttp });
    expect(result).toBeInstanceOf(FcmProvider);
  });

  it('returns SlackProvider for slack', () => {
    const fakeHttp = createFakeNotificationHttp();
    const result = createProvider('slack', {
      webhookUrl: 'https://hooks.slack.com/x',
      http: fakeHttp,
    });
    expect(result).toBeInstanceOf(SlackProvider);
  });

  it('throws for unknown provider type', () => {
    // deno-lint-ignore no-explicit-any
    expect(() => createProvider('unknown' as any, {})).toThrow(
      'Unsupported notification provider: unknown',
    );
  });
});

describe('createChannel', () => {
  it('returns EmailChannel for mail provider', () => {
    const fakeMailer = createFakeMailer();
    const ctx = {
      // deno-lint-ignore no-explicit-any
      services: {
        get(): any {
          return fakeMailer;
        },
        register: () => {},
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
      runtime: {},
    } as unknown as IPluginContext;
    const channel = createChannel('my-email', { provider: 'mail' }, ctx);
    expect(channel.name).toBe('my-email');
    expect(channel.constructor.name).toBe('EmailChannel');
  });

  it('returns SmsChannel for twilio provider', () => {
    const ctx = {
      // deno-lint-ignore no-explicit-any
      services: {
        get(): any {
          return undefined;
        },
        register: () => {},
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
      runtime: {},
    } as unknown as IPluginContext;
    const channel = createChannel('my-sms', {
      provider: 'twilio',
      options: { accountSid: 'A', authToken: 't', from: '+1' },
    }, ctx);
    expect(channel.name).toBe('my-sms');
    expect(channel.constructor.name).toBe('SmsChannel');
  });

  it('returns PushChannel for fcm provider', () => {
    const ctx = {
      // deno-lint-ignore no-explicit-any
      services: {
        get(): any {
          return undefined;
        },
        register: () => {},
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
      runtime: {},
    } as unknown as IPluginContext;
    const channel = createChannel('my-push', { provider: 'fcm', options: { serverKey: 'k' } }, ctx);
    expect(channel.name).toBe('my-push');
    expect(channel.constructor.name).toBe('PushChannel');
  });

  it('returns SlackChannel for slack provider', () => {
    const ctx = {
      // deno-lint-ignore no-explicit-any
      services: {
        get(): any {
          return undefined;
        },
        register: () => {},
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
      runtime: {},
    } as unknown as IPluginContext;
    const channel = createChannel('my-slack', {
      provider: 'slack',
      options: { webhookUrl: 'https://hooks.slack.com/x' },
    }, ctx);
    expect(channel.name).toBe('my-slack');
    expect(channel.constructor.name).toBe('SlackChannel');
  });

  it('throws for unknown provider type', () => {
    const ctx = {
      // deno-lint-ignore no-explicit-any
      services: {
        get(): any {
          return undefined;
        },
        register: () => {},
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
      runtime: {},
    } as unknown as IPluginContext;
    // deno-lint-ignore no-explicit-any
    expect(() => createChannel('x', { provider: 'bogus' as any }, ctx)).toThrow(
      'Unsupported notification provider: bogus',
    );
  });
});
