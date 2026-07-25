/**
 * Tests for `SlackProvider` — HTTP webhook transport via fake `INotificationHttp`.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { SlackProvider } from '../../src/providers/slack-provider.ts';
import type { SlackProviderOptions } from '../../src/index.ts';
import { createFakeNotificationHttp } from '../fixtures/fake-notification-http.ts';

describe('SlackProvider', () => {
  it('throws on missing webhookUrl', () => {
    // An empty options object is a JS caller's mistake; the ctor must reject it.
    expect(() => new SlackProvider({} as SlackProviderOptions)).toThrow(
      'SlackProvider requires "webhookUrl"',
    );
  });

  it('POSTs JSON with text and optional channel', async () => {
    const fakeHttp = createFakeNotificationHttp({ responseBody: 'ok', responseOk: true });
    const provider = new SlackProvider({
      webhookUrl: 'https://hooks.slack.com/webhook',
      http: fakeHttp,
    });

    await provider.send({ text: 'Hello', channel: '#alerts' });

    const call = fakeHttp.getLastCall();
    expect(call).toBeDefined();
    expect(call!.url).toBe('https://hooks.slack.com/webhook');
    expect(call!.headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(call!.body);
    expect(body.text).toBe('Hello');
    expect(body.channel).toBe('#alerts');
  });

  it('omits channel when not provided (exactOptionalPropertyTypes)', async () => {
    const fakeHttp = createFakeNotificationHttp({ responseBody: 'ok', responseOk: true });
    const provider = new SlackProvider({
      webhookUrl: 'https://hooks.slack.com/webhook',
      http: fakeHttp,
    });

    await provider.send({ text: 'Hello' });

    const call = fakeHttp.getLastCall();
    const body = JSON.parse(call!.body);
    expect(body.text).toBe('Hello');
    expect('channel' in body).toBe(false);
  });

  it('resolves on success (ok=true, body="ok")', async () => {
    const fakeHttp = createFakeNotificationHttp({ responseBody: 'ok', responseOk: true });
    const provider = new SlackProvider({
      webhookUrl: 'https://hooks.slack.com/webhook',
      http: fakeHttp,
    });

    await expect(provider.send({ text: 'hi' })).resolves.toBeUndefined();
  });

  it('throws when response is not OK (non-2xx)', async () => {
    const fakeHttp = createFakeNotificationHttp({
      responseOk: false,
      responseStatus: 500,
      responseBody: 'Internal Server Error',
    });
    const provider = new SlackProvider({
      webhookUrl: 'https://hooks.slack.com/webhook',
      http: fakeHttp,
    });

    await expect(provider.send({ text: 'hi' })).rejects.toThrow(
      'Slack webhook error (500)',
    );
  });

  it('throws when 2xx but body is not "ok" (compound condition)', async () => {
    const fakeHttp = createFakeNotificationHttp({
      responseBody: 'invalid_payload',
      responseOk: true,
    });
    const provider = new SlackProvider({
      webhookUrl: 'https://hooks.slack.com/webhook',
      http: fakeHttp,
    });

    await expect(provider.send({ text: 'hi' })).rejects.toThrow(
      'Slack webhook error (unexpected response: invalid_payload)',
    );
  });
});
