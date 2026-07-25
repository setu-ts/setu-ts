/**
 * Tests for `TwilioProvider` — HTTP transport via fake `INotificationHttp`.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { TwilioProvider } from '../../src/providers/twilio-provider.ts';
import type { TwilioProviderOptions } from '../../src/index.ts';
import { createFakeNotificationHttp } from '../fixtures/fake-notification-http.ts';

/** Builds an options object missing a required credential (a JS caller's mistake). */
function partialOptions(options: Partial<TwilioProviderOptions>): TwilioProviderOptions {
  return options as TwilioProviderOptions;
}

describe('TwilioProvider', () => {
  it('throws on missing accountSid', () => {
    expect(() => new TwilioProvider(partialOptions({ authToken: 't', from: '+1' }))).toThrow(
      'TwilioProvider requires "accountSid"',
    );
  });

  it('throws on missing authToken', () => {
    expect(() => new TwilioProvider(partialOptions({ accountSid: 'A', from: '+1' }))).toThrow(
      'TwilioProvider requires "authToken"',
    );
  });

  it('throws on missing from', () => {
    expect(() => new TwilioProvider(partialOptions({ accountSid: 'A', authToken: 't' }))).toThrow(
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
    expect(call!.headers['Authorization']).toBe(`Basic ${btoa('AC123:token')}`);
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
