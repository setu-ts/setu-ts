import { expect, it, vi } from 'vitest';
import { CAPABILITIES, withHttpStatusHint } from '@setu-ts/common';
import type { ILogger } from '@setu-ts/common';
import { createApplication } from '../../src/application/application.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

for (const status of [400, 499, 503, undefined]) {
  for (const logger of [false, true]) {
    it(`M131b 3.4 fallback status ${status} logger=${logger}`, async () => {
      const fake = createFakeRuntime();
      const report = vi.fn();
      fake.runtime.reportError = report;
      const errorLog = vi.fn();
      const warnLog = vi.fn();
      const app = createApplication({
        plugins: [
          {
            name: 'runtime',
            version: '1.0.0',
            provides: [CAPABILITIES.RUNTIME],
            register(ctx) {
              ctx.services.register(CAPABILITIES.RUNTIME, fake.runtime);
              if (logger)
                ctx.services.register(CAPABILITIES.LOGGER, {
                  error: errorLog,
                  warn: warnLog,
                } as unknown as ILogger);
            },
          },
        ],
      });
      const error = new Error('private message');
      if (status !== undefined)
        withHttpStatusHint(error, { status, title: 'Nonstandard title', detail: 'safe detail' });
      app.router.post('/', () => {
        throw error;
      });
      await app.start();
      try {
        const response = await app.inject({ method: 'POST', url: '/' });
        const client = status !== undefined && status < 500;
        expect(response.statusCode).toBe(client ? status : 500);
        expect(response.json()).toEqual(
          client
            ? // The hint's own title, as errorHandler serves it (buildErrorFromInit).
              { error: 'Nonstandard title', detail: 'safe detail' }
            : { error: 'Internal Server Error' },
        );
        if (logger) expect(client ? warnLog : errorLog).toHaveBeenCalledOnce();
        else
          expect(report).toHaveBeenCalledWith(
            expect.objectContaining({ level: client ? 'warn' : 'error' }),
          );
      } finally {
        await app.stop();
      }
    });
  }
}
