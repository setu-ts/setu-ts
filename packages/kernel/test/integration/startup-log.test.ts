/**
 * M113h §3.9 — the kernel announces a successful `listen`.
 *
 * Node and Bun print nothing when they bind, so a booted project and one that
 * was still starting looked identical. The kernel now logs through
 * {@linkcode CAPABILITIES.LOGGER} after `adapter.listen` resolves. Deno prints
 * its own native banner as well; this line is additive and both are accurate.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';
import { CAPABILITIES } from '@setu-ts/common';
import type { ILogger, IPlugin, IPluginContext } from '@setu-ts/common';
import { RuntimePlugin } from '@setu-ts/runtime';

import { createApplication } from '../../src/index.ts';
import { unusedPort } from '../../../../test/node-helpers.ts';

/** One captured `info` call. */
type InfoCall = readonly [message: string, metadata: Readonly<Record<string, unknown>> | undefined];

/**
 * A plugin that provides `CAPABILITIES.LOGGER` and records its `info` calls.
 *
 * @param calls - The array to append to
 * @returns The plugin
 */
function capturingLogger(calls: InfoCall[]): IPlugin {
  const logger: ILogger = {
    level: 'info',
    fatal: () => {},
    error: () => {},
    warn: () => {},
    info: (message, metadata) => calls.push([message, metadata]),
    debug: () => {},
    trace: () => {},
    child: () => logger,
  };
  return {
    name: 'capturing-logger',
    version: '1.0.0',
    provides: [CAPABILITIES.LOGGER],
    register(ctx: IPluginContext): void {
      ctx.services.register(CAPABILITIES.LOGGER, logger);
    },
  };
}

/** A logger whose `info` throws, as a broken custom logger would. */
function throwingLogger(): IPlugin {
  const logger: ILogger = {
    level: 'info',
    fatal: () => {},
    error: () => {},
    warn: () => {},
    info: () => {
      throw new Error('logger is broken');
    },
    debug: () => {},
    trace: () => {},
    child: () => logger,
  };
  return {
    name: 'throwing-logger',
    version: '1.0.0',
    provides: [CAPABILITIES.LOGGER],
    register(ctx: IPluginContext): void {
      ctx.services.register(CAPABILITIES.LOGGER, logger);
    },
  };
}

describe('the kernel startup line', () => {
  it('logs the configured port once, after a real adapter binds', async () => {
    const calls: InfoCall[] = [];
    const port = await unusedPort();
    const app = createApplication({ plugins: [RuntimePlugin(), capturingLogger(calls)] });
    try {
      await app.start({ port });
      expect(calls.filter(([message]) => message === 'Server listening')).toEqual([
        ['Server listening', { port }],
      ]);
    } finally {
      await app.stop();
    }
  });

  it('includes the hostname only when one was supplied', async () => {
    const calls: InfoCall[] = [];
    const port = await unusedPort();
    const app = createApplication({ plugins: [RuntimePlugin(), capturingLogger(calls)] });
    try {
      await app.start({ port, hostname: '127.0.0.1' });
      expect(calls).toContainEqual(['Server listening', { port, hostname: '127.0.0.1' }]);
    } finally {
      await app.stop();
    }
  });

  it('reports an ephemeral port as a sentence, never as the literal zero', async () => {
    const calls: InfoCall[] = [];
    const app = createApplication({ plugins: [RuntimePlugin(), capturingLogger(calls)] });
    try {
      await app.start({ port: 0 });
      const line = calls.find(([message]) => message.startsWith('Server listening'));
      expect(line).toEqual(['Server listening on an ephemeral port', undefined]);
      expect(calls.some(([, metadata]) => metadata?.['port'] === 0)).toBe(false);
    } finally {
      await app.stop();
    }
  });

  it('emits nothing when no logger is registered', async () => {
    const port = await unusedPort();
    const app = createApplication({ plugins: [RuntimePlugin()] });
    try {
      // No channel exists, so the only observable property is that start is
      // unaffected — and that it did bind (a later stop is clean).
      await expect(app.start({ port })).resolves.toBeUndefined();
    } finally {
      await app.stop();
    }
  });

  it('never fails start() when the logger itself throws', async () => {
    const port = await unusedPort();
    const app = createApplication({ plugins: [RuntimePlugin(), throwingLogger()] });
    try {
      await expect(app.start({ port })).resolves.toBeUndefined();
    } finally {
      await app.stop();
    }
  });
});
