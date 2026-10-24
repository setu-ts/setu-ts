import { describe, expect, it, vi } from 'vitest';
import type {
  HealthReport,
  IHealthIndicator,
  IHealthService,
  ILogger,
  IPlugin,
} from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { HealthPlugin, HealthService } from '../../src/index.ts';
import type { HealthPluginOptions } from '../../src/index.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

describe('HealthPlugin readiness options', () => {
  it.each([
    null,
    [],
    ['canary-topology'],
    new Date(0),
    new Map([['include', ['canary-topology']]]),
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

  it('applies exclude to an indicator registered directly through IHealthService', async () => {
    const warn = vi.fn();
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
    const direct: IPlugin = {
      name: 'direct-registrant',
      version: '1.0.0',
      dependencies: ['health'],
      register(ctx): void {
        ctx.lifecycle.onInit(() => {
          ctx.services
            .get<IHealthService>(CAPABILITIES.HEALTH)
            .registerIndicator('dependency', () => Promise.resolve({ status: 'down' }));
        });
      },
    };
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        logger,
        HealthPlugin({ readiness: { exclude: ['dependency'] } }),
        direct,
      ],
    });
    await app.start();
    try {
      const ready = await app.inject({ method: 'GET', url: '/ready' });
      const health = await app.inject({ method: 'GET', url: '/health' });
      expect(ready.statusCode).toBe(200);
      expect(health.statusCode).toBe(503);
      // Registered from a LATER plugin's onInit: the name matches, so no warning.
      expect(warn).not.toHaveBeenCalled();
    } finally {
      await app.stop();
    }
  });

  it('honours the same override when HealthService is constructed directly', async () => {
    const service = new HealthService(createFakeRuntime(), {
      readiness: { include: ['mail'], exclude: ['database'] },
    });
    service.registerIndicator('mail', () => Promise.resolve({ status: 'down' }), {
      readiness: false,
    });
    service.registerIndicator('database', () => Promise.resolve({ status: 'down' }));
    const report: HealthReport = await service.checkReady();
    expect(Object.keys(report.checks)).toEqual(['mail']);
    expect(() => new HealthService(createFakeRuntime(), { readiness: [] as never })).toThrow(
      TypeError,
    );
  });
});
