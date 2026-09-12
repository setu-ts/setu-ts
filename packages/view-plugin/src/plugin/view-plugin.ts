/**
 * ViewPlugin — registers an {@linkcode IViewEngine} under
 * `CAPABILITIES.VIEW`, so a handler can answer with HTML it did not
 * concatenate by hand: `@Render(Component)` in the decorator plugin and the
 * free `renderView` function both resolve this same registration.
 *
 * Rendering is stateless and touches no backend, so there is nothing to probe
 * and nothing to release: the `view` health indicator reports the selected
 * engine and is always `up` (M90b's rule — a probe must not fabricate
 * reachability it cannot observe), and the plugin declares no `onClose`.
 * Declaring no `dependencies` and no `optionalDependencies` is deliberate:
 * the plugin renders pure functions, needs no metadata store, and registers
 * under a token nothing depends back on — so the decorator plugin's
 * `optionalDependencies` edge (decorator → view) cannot form a cycle.
 *
 * @module
 * @since 0.5.0
 */
import type { IPlugin, IPluginContext, IViewEngine } from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';

import { ViewEngine } from '../engines/view-engine.ts';

import type { ViewPluginOptions } from './options.ts';
import denoJson from '../../deno.json' with { type: 'json' };

/** Plugin name — matches the package name without the scope. */
const PLUGIN_NAME = 'view-plugin';

/** Selects the engine the options' discriminated union describes. */
function selectEngine(options: ViewPluginOptions): IViewEngine {
  if (options.engine === 'custom') {
    return options.view;
  }
  // `'hono-jsx'` and `'hono-html'` name the AUTHORING mode, not a rendering
  // strategy — both return values funnel through the same normalization, so
  // both get the same engine. The selected mode is reported by the health
  // indicator; see ViewPluginOptions for why it is still declared.
  return new ViewEngine();
}

/**
 * Creates the ViewPlugin.
 *
 * The plugin registers one engine under `CAPABILITIES.VIEW` and a `view`
 * health indicator reporting the selected engine. The `@Render` decorator
 * resolves the engine once at `register()` (the `optionalDependencies` edge on
 * `DecoratorPlugin` is what makes that a contract rather than priority luck)
 * and `renderView` resolves it per request — both entry points honor the same
 * configured engine.
 *
 * @param options - Engine selection; omit for the default `'hono-jsx'` arm
 * @returns The plugin instance
 * @example
 * ```typescript
 * import { App } from '@setu-ts/kernel';
 * import { ViewPlugin } from '@setu-ts/view-plugin';
 *
 * app.register(ViewPlugin()); // or ViewPlugin({ engine: 'hono-html' })
 * ```
 * @since 0.5.0
 */
export function ViewPlugin(options: ViewPluginOptions = {}): IPlugin {
  const engine = selectEngine(options);
  const engineName = options.engine ?? 'hono-jsx';
  return {
    name: PLUGIN_NAME,
    version: denoJson.version,
    provides: [CAPABILITIES.VIEW],
    register(ctx: IPluginContext): void {
      ctx.services.register(CAPABILITIES.VIEW, engine);
      // Reporting the selected engine is a real fact; an invented round trip
      // would be the opposite (M90b).
      ctx.health.register(
        'view',
        () => Promise.resolve({ status: 'up' as const, data: { engine: engineName } }),
      );
    },
  };
}
