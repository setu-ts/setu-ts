/**
 * Tests for `FcmProvider` — FCM HTTP v1 transport via fake `INotificationHttp`.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IRuntimeServices } from '@hono-enterprise/common';
import { FcmProvider } from '../../src/providers/fcm-provider.ts';
import type { FcmProviderOptions, FcmTokenSource } from '../../src/index.ts';
import { createFakeFcmHttp } from '../fixtures/fake-fcm-http.ts';

/** A token source that answers instantly, so provider tests need no crypto. */
const stubTokenSource: FcmTokenSource = {
  getAccessToken: (): Promise<string> => Promise.resolve('ya29.test-token'),
};

/** Minimal valid options using the stub token source. */
function options(overrides: Partial<FcmProviderOptions> = {}): FcmProviderOptions {
  return { projectId: 'my-project', tokenSource: stubTokenSource, ...overrides };
}

describe('FcmProvider', () => {
  it('throws when projectId is missing', () => {
    expect(() => new FcmProvider({} as FcmProviderOptions)).toThrow(
      'FcmProvider requires "projectId"',
    );
  });

  it('throws for each service-account field missing when no tokenSource is given', () => {
    const runtime = {} as IRuntimeServices;

    expect(() => new FcmProvider({ projectId: 'p' } as FcmProviderOptions)).toThrow(
      'FcmProvider requires "clientEmail"',
    );
    expect(() => new FcmProvider({ projectId: 'p', clientEmail: 'a@b.com' } as FcmProviderOptions))
      .toThrow('FcmProvider requires "privateKey"');
    expect(() =>
      new FcmProvider(
        { projectId: 'p', clientEmail: 'a@b.com', privateKey: 'pem' } as FcmProviderOptions,
      )
    ).toThrow('FcmProvider requires "runtime"');

    // All four present -> constructs.
    expect(() =>
      new FcmProvider({
        projectId: 'p',
        clientEmail: 'a@b.com',
        privateKey: 'pem',
        runtime,
      })
    ).not.toThrow();
  });

  it('POSTs to the v1 messages:send endpoint with a Bearer token', async () => {
    const http = createFakeFcmHttp();
    const provider = new FcmProvider(options({ http }));

    await provider.send({ to: 'device-token', title: 'Hi', body: 'Message' });

    const [call] = http.callsMatching('messages:send');
    expect(call.url).toBe('https://fcm.googleapis.com/v1/projects/my-project/messages:send');
    expect(call.headers['Authorization']).toBe('Bearer ya29.test-token');
    expect(call.headers['Content-Type']).toBe('application/json');
  });

  it('nests the payload under message with the device token and title', async () => {
    const http = createFakeFcmHttp();
    const provider = new FcmProvider(options({ http }));

    await provider.send({ to: 'device-token', title: 'Hi', body: 'Message' });

    const body = JSON.parse(http.callsMatching('messages:send')[0].body);
    expect(body).toEqual({
      message: {
        token: 'device-token',
        notification: { body: 'Message', title: 'Hi' },
      },
    });
    // The legacy top-level `to` must not survive the migration.
    expect('to' in body).toBe(false);
  });

  it('omits title entirely when the message has none', async () => {
    const http = createFakeFcmHttp();
    const provider = new FcmProvider(options({ http }));

    await provider.send({ to: 'device-token', body: 'Message' });

    const body = JSON.parse(http.callsMatching('messages:send')[0].body);
    expect(body.message.notification).toEqual({ body: 'Message' });
    expect('title' in body.message.notification).toBe(false);
  });

  it('throws when the send response is not OK', async () => {
    const http = createFakeFcmHttp({
      send: { ok: false, status: 404, text: 'requested entity was not found' },
    });
    const provider = new FcmProvider(options({ http }));

    await expect(provider.send({ to: 'stale-token', body: 'Hi' })).rejects.toThrow(
      'FCM API error (404): requested entity was not found',
    );
  });

  it('propagates a token-source failure without calling the send endpoint', async () => {
    const http = createFakeFcmHttp();
    const failing: FcmTokenSource = {
      getAccessToken: (): Promise<string> => Promise.reject(new Error('no credentials')),
    };
    const provider = new FcmProvider({ projectId: 'p', tokenSource: failing, http });

    await expect(provider.send({ to: 't', body: 'Hi' })).rejects.toThrow('no credentials');
    expect(http.callsMatching('messages:send').length).toBe(0);
  });
});
