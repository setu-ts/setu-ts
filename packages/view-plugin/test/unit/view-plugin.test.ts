/**
 * `ViewPlugin` — the capability registration, the discriminated-option arms,
 * the `view` health indicator, and the empty dependency arrays that make the
 * decorator plugin's `optionalDependencies` edge acyclic (M92 §3.9, §3.14).
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { ViewPlugin } from '../../src/plugin/view-plugin.ts';
import { ViewEngine } from '../../src/engines/view-engine.ts';
import type { IViewEngine } from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';
import type { HealthIndicatorFn, IPlugin, IPluginContext } from '@setu-ts/common';

/** A minimal recording context — only `services` and `health.register` are read. */
function createRecordingContext(): {
  readonly ctx: IPluginContext;
  readonly registered: Map<string, unknown>;
  indicator: HealthIndicatorFn | undefined;
} {
  const registered = new Map<string, unknown>();
  let indicator: HealthIndicatorFn | undefined;
  const ctx = {
    services: {
      register: (token: string, service: unknown) => {
        registered.set(token, service);
      },
      has: (token: string) => registered.has(token),
      get: <T>(token: string) => registered.get(token) as T,
    },
    health: {
      register: (_name: string, fn: HealthIndicatorFn) => {
        indicator = fn;
      },
    },
  } as unknown as IPluginContext;
  return {
    ctx,
    registered,
    get indicator() {
      return indicator;
    },
  };
}

describe('ViewPlugin', () => {
  it('declares the plugin contract shape', () => {
    const plugin: IPlugin = ViewPlugin();

    expect(plugin.name).toBe('view-plugin');
    expect(plugin.version).toBe('0.5.0');
    expect(plugin.provides).toEqual([CAPABILITIES.VIEW]);
  });

  it('declares NO dependencies and NO optionalDependencies — the acyclicity contract', () => {
    // M92 §3.9: view-plugin declares nothing, so the decorator → view edge
    // cannot form a cycle (the M90i P1 failure in the opposite direction).
    const plugin = ViewPlugin();

    expect(plugin.dependencies).toBeUndefined();
    expect(plugin.optionalDependencies).toBeUndefined();
    expect('onClose' in plugin).toBe(false);
  });

  it('registers the default JSX arm when no options are given', async () => {
    const { ctx, registered } = createRecordingContext();

    await ViewPlugin().register(ctx);

    expect(ctx.services.has(CAPABILITIES.VIEW)).toBe(true);
    expect(registered.get(CAPABILITIES.VIEW)).toBeInstanceOf(ViewEngine);
  });

  it('registers the tagged-template arm when selected', async () => {
    const { ctx, registered } = createRecordingContext();

    await ViewPlugin({ engine: 'hono-html' }).register(ctx);

    expect(registered.get(CAPABILITIES.VIEW)).toBeInstanceOf(ViewEngine);
  });

  it('the view indicator reports the selected engine and is always up', async () => {
    for (
      const [options, expected] of [
        [{}, 'hono-jsx'],
        [{ engine: 'hono-jsx' }, 'hono-jsx'],
        [{ engine: 'hono-html' }, 'hono-html'],
        [{ engine: 'custom', view: { render: () => '' } as IViewEngine }, 'custom'],
      ] as const
    ) {
      // Read the captured indicator through the object AFTER register() —
      // destructuring would bind the (still undefined) value before it.
      const recording = createRecordingContext();
      const plugin = ViewPlugin(options);

      await plugin.register(recording.ctx);
      expect(recording.indicator).toBeDefined();

      const result = await recording.indicator!();
      expect(result.status).toBe('up');
      expect(result.data).toEqual({ engine: expected });
    }
  });
});
