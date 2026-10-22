import { describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/pg-proxy';
import { pgTable, text } from 'drizzle-orm/pg-core';
import { CAPABILITIES } from '@setu-ts/common';
import type { IDatabaseService } from '../../src/index.ts';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { errorHandler } from '@setu-ts/exceptions';
import { DatabasePlugin, createDrizzleDatabase } from '../../src/index.ts';
import { RecordingLogger } from '../../../logger-plugin/test/fixtures/recording-logger.ts';

describe('real Drizzle diagnostics through a kernel error log', () => {
  for (const [code, status] of [
    [undefined, 500],
    ['40001', 409],
    ['23505', 409],
    ['08006', 503],
  ] as const) {
    it(`keeps SQL and classification ${String(code)}, without values in message or stack`, async () => {
      const driver = Object.assign(
        new Error('driver rejected'),
        code === undefined ? {} : { code },
      );
      const database = drizzle(() => Promise.reject(driver));
      const users = pgTable('users', { id: text('id').primaryKey(), email: text('email') });
      const app = createApplication({
        plugins: [
          RuntimePlugin(),
          DatabasePlugin({
            type: 'drizzle',
            options: {
              drizzleInstance: createDrizzleDatabase(database, (configured, work) =>
                configured.transaction(work),
              ),
              drizzleTables: { User: users },
            },
          }),
        ],
      });
      app.middleware.add(errorHandler(), { priority: 0 });
      app.router.get('/query', async (ctx) => {
        await ctx.services
          .get<IDatabaseService>(CAPABILITIES.DATABASE)
          .getRepository('User')
          .create({ id: 'private-id-749', email: 'private-email-749@example.com' });
        return ctx.response.text('unexpected');
      });
      const logger = new RecordingLogger();
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
        expect((await app.inject({ method: 'GET', url: '/query' })).statusCode).toBe(status);
        expect(logger.calls).toHaveLength(1);
        const logged = JSON.stringify(logger.calls[0]);
        expect(logged).toContain('insert into');
        expect(logged).toContain('users');
        expect(logged).toContain('$1');
        expect(logged).toContain('stack');
        expect(logged).not.toContain('private-id-749');
        expect(logged).not.toContain('private-email-749');
        expect(logged).not.toContain('params:');
        if (code !== undefined) expect(logged).toContain(code);
      } finally {
        await app.stop();
      }
    });
  }
});
