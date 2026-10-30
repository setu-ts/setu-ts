import { describe, expect, it } from 'vitest';
import { CAPABILITIES, ERROR_RESPONDER_STATE_KEY, withHttpStatusHint } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { errorHandler, HttpError, notFound } from '@setu-ts/exceptions';
import { LoggerPlugin } from '../../src/index.ts';
import { RecordingLogger } from '../fixtures/recording-logger.ts';

describe('request completion status', () => {
  for (const handler of [true, false]) {
    it(`logs the served rule status once (errorHandler=${handler})`, async () => {
      const app = createApplication({
        plugins: [RuntimePlugin(), LoggerPlugin({ transport: 'noop', requestLogging: true })],
      });
      if (handler) app.middleware.add(errorHandler(), { priority: 0 });
      const cases = [
        ['/missing', notFound('missing'), 404],
        ['/fault', new Error('fault'), 500],
        [
          '/hint',
          withHttpStatusHint(new Error('driver'), {
            status: 409,
            title: 'Conflict',
            detail: 'retry',
          }),
          409,
        ],
        ['/clamp', new HttpError(4004, 'typo'), 500],
      ] as const;
      for (const [path, error] of cases)
        app.router.get(path, () => {
          throw error;
        });
      app.router.get('/ok', (ctx) => ctx.response.status(201).text('created'));
      const logger = new RecordingLogger();
      app.register({
        name: 'recording-logger',
        version: '1.0.0',
        register: (ctx) => {
          ctx.services.register(CAPABILITIES.LOGGER, logger, { override: true });
        },
      });
      await app.start();
      try {
        for (const [path, , expected] of cases) {
          logger.calls.length = 0;
          const res = await app.inject({ method: 'GET', url: path });
          const status = handler ? expected : 500;
          expect(res.statusCode).toBe(status);
          expect(logger.calls.filter((c) => c.level === 'info')).toEqual([
            {
              level: 'info',
              message: 'request completed',
              meta: { method: 'GET', path, status, duration: expect.any(Number) },
            },
          ]);
          expect(logger.calls.some((c) => c.message === 'request failed')).toBe(false);
          const faults = logger.calls.filter(
            (c) =>
              c.level === (handler && status < 500 ? 'warn' : 'error') &&
              !c.message.includes('unserveable'),
          );
          expect(faults).toHaveLength(1);
        }
        logger.calls.length = 0;
        await app.inject({ method: 'GET', url: '/ok' });
        expect(logger.calls).toEqual([
          {
            level: 'info',
            message: 'request completed',
            meta: { method: 'GET', path: '/ok', status: 201, duration: expect.any(Number) },
          },
        ]);
      } finally {
        await app.stop();
      }
    });
  }

  it('falls back to 500 for a legacy responder without statusFor', async () => {
    const app = createApplication({
      plugins: [RuntimePlugin(), LoggerPlugin({ transport: 'noop', requestLogging: true })],
    });
    app.middleware.add(
      async (ctx, next) => {
        ctx.state.set(ERROR_RESPONDER_STATE_KEY, { respond: () => {} });
        await next();
      },
      { priority: 0 },
    );
    app.router.get('/fault', () => {
      throw new Error('fault');
    });
    const logger = new RecordingLogger();
    app.register({
      name: 'recording-logger',
      version: '1.0.0',
      register: (ctx) => {
        ctx.services.register(CAPABILITIES.LOGGER, logger, { override: true });
      },
    });
    await app.start();
    try {
      await app.inject({ method: 'GET', url: '/fault' });
      expect(logger.calls.filter((call) => call.level === 'info')).toEqual([
        {
          level: 'info',
          message: 'request completed',
          meta: { method: 'GET', path: '/fault', status: 500, duration: expect.any(Number) },
        },
      ]);
    } finally {
      await app.stop();
    }
  });
});
