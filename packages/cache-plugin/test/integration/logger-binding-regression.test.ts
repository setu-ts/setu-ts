import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { LoggerPlugin } from '@setu-ts/logger-plugin';
import { CachePlugin } from '../../src/index.ts';

/**
 * Regression test for the resolveLogger this-binding bug.
 * This test uses the REAL default ConsoleLogger (via LoggerPlugin with its defaults)
 * and would have caught the detached-method call issue in resolveLogger.
 * Without the fix, app.start() would throw TypeError: Cannot read properties of undefined.
 */
describe('Cache plugin resolveLogger regression', () => {
  it('should start without throwing when using real ConsoleLogger', async () => {
    // Build a real kernel app with RuntimePlugin + LoggerPlugin (default = ConsoleLogger) + CachePlugin
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        LoggerPlugin(), // Uses ConsoleLogger by default - THIS IS THE KEY: real logger, not fake
        CachePlugin(),
      ],
    });

    // Starting the app should NOT throw - this exercises resolveLogger's debug call during CachePlugin registration
    // With the buggy resolveLogger, this would throw: TypeError: Cannot read properties of undefined (reading 'ConsoleLogger')
    await expect(app.start()).resolves.toBeUndefined();

    // Clean up
    await app.stop();
  });
});
