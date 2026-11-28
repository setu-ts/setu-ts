import { describe, expect, it, vi } from 'vitest';
import { CAPABILITIES, httpStatusHintOf } from '@setu-ts/common';
import type { IMessageBroker } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { errorHandler } from '@setu-ts/exceptions';
import { MessagingPlugin, RequestTimeoutError, RemoteHandlerError } from '../../src/index.ts';

describe('RPC error status', () => {
  it('keeps the timeout constructor compatible and exposes safe hints', () => {
    expect(new RequestTimeoutError('custom').message).toBe('custom');
    expect(httpStatusHintOf(new RequestTimeoutError())).toEqual({
      status: 504,
      title: 'Gateway Timeout',
      detail: 'No reply arrived in time; the request may have been handled.',
    });
    expect(httpStatusHintOf(new RemoteHandlerError('remote-secret'))).toEqual({
      status: 502,
      title: 'Bad Gateway',
      detail: 'The service that handled the request failed.',
    });
  });

  it.each([false, true])('serves safe Problem Details for remote failure=%s', async (remote) => {
    vi.useFakeTimers();
    const app = createApplication({ plugins: [RuntimePlugin(), MessagingPlugin()] });
    app.middleware.add(errorHandler({ format: 'rfc9457', logErrors: false }), { priority: 10 });
    let caught: unknown;
    app.router.get('/rpc', async (ctx) => {
      try {
        await ctx.services
          .get<IMessageBroker>(CAPABILITIES.MESSAGING)
          .request('orders', {}, { timeoutMs: 25 });
      } catch (error) {
        caught = error;
        throw error;
      }
      return ctx.response.json({ ok: true });
    });
    await app.start();
    try {
      if (remote)
        await app.services.get<IMessageBroker>(CAPABILITIES.MESSAGING).respond('orders', () => {
          throw new Error('remote-secret');
        });
      const response = app.fetch(new Request('http://localhost/rpc'));
      await vi.advanceTimersByTimeAsync(25);
      const result = await response;
      expect(result.status).toBe(remote ? 502 : 504);
      const body: unknown = await result.json();
      expect(body).toMatchObject({
        status: remote ? 502 : 504,
        title: remote ? 'Bad Gateway' : 'Gateway Timeout',
        detail: remote
          ? 'The service that handled the request failed.'
          : 'No reply arrived in time; the request may have been handled.',
      });
      expect(body).toHaveProperty('type');
      expect(body).not.toHaveProperty('message');
      expect(body).not.toHaveProperty('remoteMessage');
      expect(JSON.stringify(body)).not.toContain('remote-secret');
      if (!remote) expect(caught).toMatchObject({ topic: 'orders', timeoutMs: 25 });
    } finally {
      await app.stop();
      vi.useRealTimers();
    }
  });
});
