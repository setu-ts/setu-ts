/**
 * Tests for `TwilioProvider` — HTTP transport via fake `INotificationHttp`.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { TwilioProvider } from '../../src/providers/twilio-provider.ts';
import { createFakeNotificationHttp } from '../fixtures/fake-notification-http.ts';

describe('TwilioProvider', () => {
  it('throws on missing accountSid', () => {
    // deno-lint-ignore no-explicit-any
    expect(() => new TwilioProvider({ authToken: 't', from: '+1' } as any)).toThrow(
      'TwilioProvider requires "accountSid"',
    );
  });

  it('throws on missing authToken', () => {
    // deno-lint-ignore no-explicit-any
    expect(() => new TwilioProvider({ accountSid: 'A', from: '+1' } as any)).toThrow(
      'TwilioProvider requires "authToken"',
    );
  });

  it('throws on missing from', () => {
    // deno-lint-ignore no-explicit-any
    expect(() => new TwilioProvider({ accountSid: 'A', authToken: 't' } as any)).toThrow(
      'TwilioProvider requires "from"',
    );
  });

  it('POSTs to the correct Twilio endpoint with form body and Basic auth', async () => {
    const fakeHttp = createFakeNotificationHttp({
      responseBody: '{"sid":"msg1"}',
      responseOk: true,
    });
    const provider = new TwilioProvider({
      accountSid: 'AC123',
      authToken: 'token',
      from: '+19998887777',
      http: fakeHttp,
    });

    await provider.send({ to: '+15554443333', body: 'Hello' });

    const call = fakeHttp.getLastCall();
    expect(call).toBeDefined();
    expect(call!.url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json');
    expect(call!.headers['Authorization']).toMatch(/^Basic /);
    expect(call!.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(call!.body).toContain('To=%2B15554443333');
    expect(call!.body).toContain('From=%2B19998887777');
    expect(call!.body).toContain('Body=Hello');
  });

  it('throws when response is not OK', async () => {
    const fakeHttp = createFakeNotificationHttp({
      responseOk: false,
      responseStatus: 401,
      responseBody: 'Unauthorized',
    });
    const provider = new TwilioProvider({
      accountSid: 'AC123',
      authToken: 'token',
      from: '+19998887777',
      http: fakeHttp,
    });

    await expect(provider.send({ to: '+15554443333', body: 'Hi' })).rejects.toThrow(
      'Twilio API error (401)',
    );
  });
});
