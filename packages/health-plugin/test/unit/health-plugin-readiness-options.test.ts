import { describe, expect, it, vi } from 'vitest';
import type { HealthReport, IHealthIndicator, ILogger, IPlugin } from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { HealthPlugin } from '../../src/index.ts';
import type { HealthPluginOptions } from '../../src/index.ts';

describe('HealthPlugin readiness options', () => {
  it.each([
    null,
    'canary-topology',
    42,
    { include: 'canary-topology' },
    { exclude: {} },
    { include: [''] },
    { exclude: ['  '] },
    { include: [42] },
    { include: ['self'] },
    { exclude: ['self'] },
    { include: ['canary-topology'], exclude: ['canary-topology'] },
  ])('refuses invalid readiness without echoing configured names (%j)', (readiness) => {
    let failure: unknown;
    try {
      HealthPlugin({ readiness: readiness as NonNullable<HealthPluginOptions['readiness']> });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(TypeError);
    expect((failure as Error).message).toContain('readiness');
    expect((failure as Error).message).not.toContain('canary-topology');
  });

  it.each(['instance', 'factory', 'contribution'] as const)(
    'carries declared membership from %s and honors both overrides through endpoints',
    async (source) => {
      for (const override of [undefined, 'include', 'exclude'] as const) {
        const down = vi.fn(() => Promise.resolve({ status: 'down' as const }));
        const indicator: IHealthIndicator = {
          name: 'dependency',
          readiness: override === 'exclude',
          check: down,
        };
        const contributor: IPlugin = {
          name: 'contributor',
          version: '1.0.0',
          register(ctx): void {
            if (source === 'contribution')
              ctx.health.register(indicator.name, indicator.check, {
                readiness: indicator.readiness!,
              });
          },
        };
        const app = createApplication({
          plugins: [
            RuntimePlugin(),
            HealthPlugin({
              indicators:
                source === 'instance' ? [indicator] : source === 'factory' ? [() => indicator] : [],
              ...(override === undefined ? {} : { readiness: { [override]: ['dependency'] } }),
            }),
            contributor,
          ],
        });
        await app.start();
        try {
          const ready = await app.inject({ method: 'GET', url: '/ready' });
          expect(ready.statusCode).toBe(override === 'include' ? 503 : 200);
          expect(Object.keys(ready.json<HealthReport>().checks)).toEqual(
            override === 'include' ? ['dependency'] : [],
          );
          expect(down).toHaveBeenCalledTimes(override === 'include' ? 1 : 0);
          expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(503);
          expect((await app.inject({ method: 'GET', url: '/live' })).statusCode).toBe(200);
        } finally {
          await app.stop();
        }
      }
    },
  );

  it('warns once at initialization by count and snapshots operator arrays', async () => {
    const warn = vi.fn();
    const include = ['canary-topology', 'other-secret'];
    const plugin = HealthPlugin({ readiness: { include, exclude: ['third-secret'] } });
    include.push('mutated-secret');
    const logger: IPlugin = {
      name: 'logger',
      version: '1.0.0',
      provides: [CAPABILITIES.LOGGER],
      register(ctx): void {
        ctx.services.register(CAPABILITIES.LOGGER, {
          warn,
          debug() {},
          info() {},
          error() {},
        } as unknown as ILogger);
      },
    };
    const app = createApplication({ plugins: [RuntimePlugin(), logger, plugin] });
    await app.start();
    try {
      await app.inject({ method: 'GET', url: '/ready' });
      await app.inject({ method: 'GET', url: '/ready' });
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        'Health readiness: 3 indicator name(s) match no registered indicator.',
      );
    } finally {
      await app.stop();
    }
  });
});
