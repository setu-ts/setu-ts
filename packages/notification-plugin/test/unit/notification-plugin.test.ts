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

/* ------------------------------------------------------------------ */
/*  Shared fake-context helper — mirrors sibling-plugin conventions.  */
/* ------------------------------------------------------------------ */

interface FakeContextCapture {
  registeredServices?: Map<string, unknown>;
  registeredHealth?: Map<string, unknown>;
  onCloseHandlers?: Array<() => void | Promise<void>>;
  onRegisterHandlers?: Array<() => void | Promise<void>>;
  onInitHandlers?: Array<() => void | Promise<void>>;
  onBootstrapHandlers?: Array<() => void | Promise<void>>;
  onRequestHandlers?: Array<(ctx: unknown) => void | Promise<void>>;
  onResponseHandlers?: Array<(ctx: unknown) => void | Promise<void>>;
  onShutdownHandlers?: Array<() => void | Promise<void>>;
  onErrorHandlers?: Array<(err: Error, ctx: unknown) => void | Promise<void>>;
}

/**
 * Creates a minimal fake `IPluginContext` with no bare `any` types.
 */
function createFakeContext(capture?: FakeContextCapture): IPluginContext {
  const reg = capture?.registeredServices ?? new Map<string, unknown>();
  const health = capture?.registeredHealth ?? new Map<string, unknown>();
  const onClose = capture?.onCloseHandlers ?? [];
  const onRegister = capture?.onRegisterHandlers ?? [];
  const onInit = capture?.onInitHandlers ?? [];
  const onBootstrap = capture?.onBootstrapHandlers ?? [];
  const onRequest = capture?.onRequestHandlers ?? [];
  const onResponse = capture?.onResponseHandlers ?? [];
  const onShutdown = capture?.onShutdownHandlers ?? [];
  const onError = capture?.onErrorHandlers ?? [];

  return {
    services: {
      has(_token: string): boolean {
        return reg.has(_token);
      },
      get<T>(token: string): T {
        return reg.get(token) as T;
      },
      getAll<T>(_token: string): readonly T[] {
        const v = reg.get(_token);
        return v ? ([v] as unknown as readonly T[]) : [];
      },
      register(name: string, svc: unknown): void {
        reg.set(name, svc);
      },
    },
    health: {
      register: (name: string, fn: () => Promise<{ status: string }>): void => {
        health.set(name, fn);
      },
    },
    lifecycle: {
      onClose: (fn: () => void | Promise<void>): void => {
        onClose.push(fn);
      },
      onRegister: (fn: () => void | Promise<void>): void => {
        onRegister.push(fn);
      },
      onInit: (fn: () => void | Promise<void>): void => {
        onInit.push(fn);
      },
      onBootstrap: (fn: () => void | Promise<void>): void => {
        onBootstrap.push(fn);
      },
      onRequest: (fn: (ctx: unknown) => void | Promise<void>): void => {
        onRequest.push(fn);
      },
      onResponse: (fn: (ctx: unknown) => void | Promise<void>): void => {
        onResponse.push(fn);
      },
      onShutdown: (fn: () => void | Promise<void>): void => {
        onShutdown.push(fn);
      },
      onError: (fn: (err: Error, ctx: unknown) => void | Promise<void>): void => {
        onError.push(fn);
      },
    },
    runtime: {},
  } as unknown as IPluginContext;
}

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
    const ctx = createFakeContext({
      registeredServices,
      registeredHealth,
    });

    const plugin = NotificationPlugin({ channels: {} });
    plugin.register(ctx);

    expect(registeredServices.has(CAPABILITIES.NOTIFICATION)).toBe(true);
    expect(registeredHealth.has('notification')).toBe(true);
  });
});

describe('createProvider', () => {
  it("returns IMailer for 'mail'", () => {
    const fakeMailer = createFakeMailer();
    const registeredServices = new Map<string, unknown>();
    registeredServices.set(CAPABILITIES.MAIL, fakeMailer);

    const ctx = createFakeContext({ registeredServices });
    const result = createProvider('mail', {}, ctx);
    expect(result).toBe(fakeMailer);
  });

  it('throws for mail without context', () => {
    expect(() => createProvider('mail', {} as never)).toThrow(
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
    expect(() => createProvider('unknown' as never, {})).toThrow(
      'Unsupported notification provider: unknown',
    );
  });
});

describe('createChannel', () => {
  it('returns EmailChannel for mail provider', () => {
    const fakeMailer = createFakeMailer();
    const registeredServices = new Map<string, unknown>();
    registeredServices.set(CAPABILITIES.MAIL, fakeMailer);

    const ctx = createFakeContext({ registeredServices });
    const channel = createChannel('my-email', { provider: 'mail' }, ctx);
    expect(channel.name).toBe('my-email');
    expect(channel.constructor.name).toBe('EmailChannel');
  });

  it('returns SmsChannel for twilio provider', () => {
    const ctx = createFakeContext();
    const channel = createChannel('my-sms', {
      provider: 'twilio',
      options: { accountSid: 'A', authToken: 't', from: '+1' },
    }, ctx);
    expect(channel.name).toBe('my-sms');
    expect(channel.constructor.name).toBe('SmsChannel');
  });

  it('returns PushChannel for fcm provider', () => {
    const ctx = createFakeContext();
    const channel = createChannel('my-push', { provider: 'fcm', options: { serverKey: 'k' } }, ctx);
    expect(channel.name).toBe('my-push');
    expect(channel.constructor.name).toBe('PushChannel');
  });

  it('returns SlackChannel for slack provider', () => {
    const ctx = createFakeContext();
    const channel = createChannel('my-slack', {
      provider: 'slack',
      options: { webhookUrl: 'https://hooks.slack.com/x' },
    }, ctx);
    expect(channel.name).toBe('my-slack');
    expect(channel.constructor.name).toBe('SlackChannel');
  });

  it('throws for unknown provider type', () => {
    const ctx = createFakeContext();
    expect(() => createChannel('x', { provider: 'bogus' as never }, ctx)).toThrow(
      'Unsupported notification provider: bogus',
    );
  });
});
