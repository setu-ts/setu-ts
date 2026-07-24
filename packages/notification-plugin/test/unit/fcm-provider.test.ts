/**
 * Tests for `FcmProvider` — HTTP transport via fake `INotificationHttp`.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { FcmProvider } from '../../src/providers/fcm-provider.ts';
import { createFakeNotificationHttp } from '../fixtures/fake-notification-http.ts';

describe('FcmProvider', () => {
  it('throws on missing serverKey', () => {
    // deno-lint-ignore no-explicit-any
    expect(() => new FcmProvider({} as any)).toThrow(
      'FcmProvider requires "serverKey"',
    );
  });

  it('POSTs with Authorization key header and notification body when title is present', async () => {
    const fakeHttp = createFakeNotificationHttp({ responseBody: '{}', responseOk: true });
    const provider = new FcmProvider({ serverKey: 'my-key', http: fakeHttp });

    await provider.send({ to: 'device-token', title: 'Hi', body: 'Message' });

    const call = fakeHttp.getLastCall();
    expect(call).toBeDefined();
    expect(call!.url).toBe('https://fcm.googleapis.com/fcm/send');
    expect(call!.headers['Authorization']).toBe('key=my-key');
    expect(call!.headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(call!.body);
    expect(body.to).toBe('device-token');
    expect(body.notification).toEqual({ title: 'Hi', body: 'Message' });
  });

  it('POSTs with notification body only (no title) when subject is absent', async () => {
    const fakeHttp = createFakeNotificationHttp({ responseBody: '{}', responseOk: true });
    const provider = new FcmProvider({ serverKey: 'my-key', http: fakeHttp });

    await provider.send({ to: 'device-token', body: 'Message' });

    const call = fakeHttp.getLastCall();
    const body = JSON.parse(call!.body);
    expect(body.to).toBe('device-token');
    expect(body.notification).toEqual({ body: 'Message' });
    expect('title' in body.notification).toBe(false);
  });

  it('throws when response is not OK', async () => {
    const fakeHttp = createFakeNotificationHttp({
      responseOk: false,
      responseStatus: 400,
      responseBody: 'Bad Request',
    });
    const provider = new FcmProvider({ serverKey: 'my-key', http: fakeHttp });

    await expect(provider.send({ to: 'token', body: 'Hi' })).rejects.toThrow(
      'FCM API error (400)',
    );
  });
});
