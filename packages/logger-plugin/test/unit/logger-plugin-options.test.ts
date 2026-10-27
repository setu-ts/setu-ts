import { expect, it } from 'vitest';
import { CAPABILITIES } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { LoggerPlugin } from '../../src/index.ts';
import { RecordingLogger } from '../fixtures/recording-logger.ts';

it('passes RegExp excludePaths through the plugin to the request matcher', async () => {
  const pattern = /^\/probes\//;
  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      LoggerPlugin({ transport: 'noop', requestLogging: true, excludePaths: [pattern] }),
    ],
  });
  for (const path of ['/probes/live', '/visible'])
    app.router.get(path, (ctx) => ctx.response.text('ok'));
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
    expect((await app.inject({ method: 'GET', url: '/probes/live' })).statusCode).toBe(200);
    expect(logger.calls).toEqual([]);
    await app.inject({ method: 'GET', url: '/visible' });
    expect(logger.calls).toEqual([
      {
        level: 'info',
        message: 'request completed',
        meta: { method: 'GET', path: '/visible', status: 200, duration: expect.any(Number) },
      },
    ]);
  } finally {
    await app.stop();
  }
});
