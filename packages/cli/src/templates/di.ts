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
 * Both the container's external resolver and its registry fallback are gated
 * on `autoRegister` (`di-plugin.ts`, `container.ts`); without it every
 * `@Inject(CAPABILITIES.X)` throws at startup. `DiPlugin` defaults it to `true`
 * since 0.9.0 (it was `false` through 0.8.0), and the option is still written
 * out here so the composition the developer reads states what it relies on.
 * This template's own showcase cannot surface a regression — its service has
 * no dependencies and its controller injects an explicit provider.
 *
 * Emitted as `DiPlugin({ autoRegister: true })`.
 */
export const DI_WIRING: Wiring = {
  pkg: DI_PACKAGE,
  symbol: 'DiPlugin',
  args: '{ autoRegister: true }',
};
