/**
 * `CloudflarePlugin.register` — the hostless marker and the Workers warning
 * (M113d §3.6/§3.7).
 *
 * With no `waitUntil` host the registry is marked hostless, so
 * `cacheApiMiddleware.store()` awaits the edge-cache write instead of handing
 * it to a sink that delegates to nothing; and on Workers one warning names the
 * remedy, because an application's own background work still needs a sink.
 * Off Workers nothing is logged — running the promise to completion is correct
 * there.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';
import { CAPABILITIES } from '@setu-ts/common';
import type { IPluginContext, IRuntimeServices, IServiceRegistry } from '@setu-ts/common';
import { MockServiceRegistry } from '@setu-ts/testing';

import { CloudflarePlugin } from '../../../src/index.ts';
import { isHostlessRegistry } from '../../../src/background/wait-until.ts';
import type { ICloudflareBindings } from '../../../src/bindings/binding-registry.ts';

/** A recording logger capturing `warn` calls. */
function recordingLogger(): { logger: ILoggerLike; warnings: string[] } {
  const warnings: string[] = [];
  const logger = {
    warn: (message: string): void => {
      warnings.push(message);
    },
  };
  return { logger, warnings };
}

type ILoggerLike = { warn: (message: string) => void };

/**
 * A minimal plugin context: `register()` with no capability arms touches only
 * the service registry, the runtime platform and the (optional) logger.
 */
function fakeCtx(
  platform: string,
  logger: ILoggerLike | undefined,
): { ctx: IPluginContext; services: IServiceRegistry } {
  const services = new MockServiceRegistry();
  const runtime = { platform: () => platform } as unknown as IRuntimeServices;
  const ctx = {
    services,
    runtime,
    health: { register: (): void => {} },
    ...(logger === undefined ? {} : { logger }),
  } as unknown as IPluginContext;
  return { ctx, services };
}

describe('CloudflarePlugin.register — the hostless marker and the Workers warning (M113d)', () => {
  it('marks the registry hostless and warns once on Workers without a host', () => {
    const plugin = CloudflarePlugin({ env: {} });
    const { logger, warnings } = recordingLogger();
    const { ctx, services } = fakeCtx('cloudflare-workers', logger);

    plugin.register(ctx);

    const registry = services.get<ICloudflareBindings>(CAPABILITIES.CLOUDFLARE);
    expect(isHostlessRegistry(registry)).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('bindings.waitUntil()');
    expect(warnings[0]).toContain('cloudflare:workers');
  });

  it('does not warn and does not mark when a host was injected', () => {
    const plugin = CloudflarePlugin({ env: {}, waitUntil: () => {} });
    const { logger, warnings } = recordingLogger();
    const { ctx, services } = fakeCtx('cloudflare-workers', logger);

    plugin.register(ctx);

    const registry = services.get<ICloudflareBindings>(CAPABILITIES.CLOUDFLARE);
    expect(isHostlessRegistry(registry)).toBe(false);
    expect(warnings).toEqual([]);
  });

  it('marks hostless but stays silent off Workers', () => {
    const plugin = CloudflarePlugin({ env: {} });
    const { logger, warnings } = recordingLogger();
    const { ctx, services } = fakeCtx('node', logger);

    plugin.register(ctx);

    const registry = services.get<ICloudflareBindings>(CAPABILITIES.CLOUDFLARE);
    expect(isHostlessRegistry(registry)).toBe(true);
    expect(warnings).toEqual([]);
  });

  it('tolerates a context whose logger is not yet resolvable', () => {
    const plugin = CloudflarePlugin({ env: {} });
    const { ctx, services } = fakeCtx('cloudflare-workers', undefined);

    expect(() => plugin.register(ctx)).not.toThrow();
    const registry = services.get<ICloudflareBindings>(CAPABILITIES.CLOUDFLARE);
    expect(isHostlessRegistry(registry)).toBe(true);
  });
});
