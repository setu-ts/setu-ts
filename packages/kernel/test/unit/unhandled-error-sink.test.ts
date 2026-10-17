import { describe, expect, it } from 'vitest';
import { CAPABILITIES } from '@setu-ts/common';
import { createApplication } from '../../src/index.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';
import { RecordingLogger } from '../../../logger-plugin/test/fixtures/recording-logger.ts';

describe('kernel last-resort request sink', () => {
  for (const withLogger of [false, true]) {
    it(`reports exclusively to ${withLogger ? 'logger' : 'runtime'}`, async () => {
      const records: Readonly<Record<string, unknown>>[] = [];
      const logger = new RecordingLogger();
      const runtime = createFakeRuntime().runtime;
      runtime.reportError = (record) => {
        records.push(record);
      };
      const app = createApplication({
        plugins: [
          {
            name: 'runtime',
            version: '1.0.0',
            provides: [CAPABILITIES.RUNTIME],
            register: (ctx) => {
              ctx.services.register(CAPABILITIES.RUNTIME, runtime);
            },
          },
        ],
      });
      app.router.get('/boom', () => {
        throw new Error('escaped fault');
      });
      if (withLogger)
        app.register({
          name: 'recording-logger',
          version: '1.0.0',
          provides: [CAPABILITIES.LOGGER],
          register: (ctx) => {
            ctx.services.register(CAPABILITIES.LOGGER, logger);
          },
        });
      await app.start();
      try {
        expect((await app.inject({ method: 'GET', url: '/boom' })).statusCode).toBe(500);
        expect(records).toHaveLength(withLogger ? 0 : 1);
        expect(logger.calls).toHaveLength(withLogger ? 1 : 0);
        if (!withLogger)
          expect(records[0]).toMatchObject({
            level: 'error',
            name: 'Error',
            message: 'escaped fault',
            method: 'GET',
            path: '/boom',
            requestId: expect.any(String),
            stack: expect.stringContaining('escaped fault'),
          });
      } finally {
        await app.stop();
      }
    });
  }
});
