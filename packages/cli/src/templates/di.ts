/**
 * The class-based template's `DiPlugin` wiring.
 *
 * @module
 */

import type { Wiring } from './registry.ts';

/** The bare `@setu-ts` package name of the DI plugin. */
const DI_PACKAGE = 'di-plugin';

/**
 * The `DiPlugin` wiring, declared once.
 *
 * `DiPlugin`'s options are optional (`di-plugin/src/plugin/di-plugin.ts:66`) —
 * but the default is what matters, not the optionality. `autoRegister` defaults
 * to `false`, and both the external resolver and the container's registry
 * fallback are gated on it (`di-plugin.ts:79-86`, `container.ts:174`), so a
 * bare `DiPlugin()` leaves the container unable to see the framework's own
 * services: every `@Inject(CAPABILITIES.X)` throws at startup and the entire
 * plugin ecosystem is unreachable from a service. This template's own showcase
 * cannot surface it — its service has no dependencies and its controller
 * injects an explicit provider — which is exactly why the default must be set
 * here, by the one file the developer does not hand-edit.
 *
 * Emitted as `DiPlugin({ autoRegister: true })`.
 */
export const DI_WIRING: Wiring = {
  pkg: DI_PACKAGE,
  symbol: 'DiPlugin',
  args: '{ autoRegister: true }',
};
