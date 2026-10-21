import { describe, expect, it } from 'vitest';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { createDatabaseIdempotencyStore, DatabasePlugin } from '@setu-ts/database-plugin';
import { SchedulerPlugin } from '@setu-ts/scheduler-plugin';
import { IdempotencyConfigurationError, IdempotencyPlugin } from '../../src/index.ts';

describe('README tier-C composition', () => {
  for (const scheduled of [false, true]) {
    it(
      scheduled
        ? 'starts with the real scheduler'
        : 'refuses the same composition without a scheduler',
      async () => {
        const app = createApplication({
          plugins: [
            RuntimePlugin(),
            DatabasePlugin(),
            ...(scheduled ? [SchedulerPlugin()] : []),
            IdempotencyPlugin({ transactional: { store: createDatabaseIdempotencyStore() } }),
          ],
        });
        try {
          if (scheduled) await app.start();
          else await expect(app.start()).rejects.toBeInstanceOf(IdempotencyConfigurationError);
        } finally {
          await app.stop();
        }
      },
    );
  }
});
