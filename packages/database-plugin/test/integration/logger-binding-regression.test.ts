/**
 * Regression test for the `resolveLogger` this-binding bug, driven with the
 * REAL `ConsoleLogger` that `LoggerPlugin` registers by default.
 *
 * `resolveLogger` used to extract `logger.debug` into a local and invoke it
 * detached. Both loggers `logger-plugin` ships implement `debug` in terms of a
 * private `#` field, and a private-field access on an unbound method throws
 * `TypeError` — so `logQueries: true`, a documented public option, failed on
 * **every** repository call whenever a real logger was registered.
 *
 * Nothing caught it because every existing test injected a plain-object
 * logger, where a detached method works fine (CLAUDE.md: "test doubles must
 * honor the real contract, or they hide the bug"). `cache-plugin` carries the
 * same regression test for the same bug; `database-plugin` never got one.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createApplication } from '@hono-enterprise/kernel';
import { RuntimePlugin } from '@hono-enterprise/runtime';
import { LoggerPlugin } from '@hono-enterprise/logger-plugin';
import { CAPABILITIES } from '@hono-enterprise/common';

import { DatabasePlugin } from '../../src/index.ts';
import type { IDatabaseService } from '../../src/index.ts';

describe('DatabasePlugin resolveLogger regression', () => {
  it('logs a query through the REAL ConsoleLogger without throwing', async () => {
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        LoggerPlugin({ level: 'debug' }), // real ConsoleLogger, not a fake
        DatabasePlugin({ type: 'memory', options: { logQueries: true } }),
      ],
    });
    await app.start();

    const db = app.services.get<IDatabaseService>(CAPABILITIES.DATABASE);
    const users = db.getRepository<{ id: string; name: string }>('User');

    // Without the fix this rejects with
    // `TypeError: Cannot read properties of undefined`, because the detached
    // `debug` cannot reach ConsoleLogger's private field.
    const created = await users.create({ name: 'ada' });
    expect(await users.findById(created.id)).toMatchObject({ name: 'ada' });

    await app.stop();
  });
});
