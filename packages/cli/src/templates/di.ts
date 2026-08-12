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
 * `DiPlugin`'s options are optional (`di-plugin/src/plugin/di-plugin.ts:66`),
 * so no `args` string is needed and the emitted call is a bare `DiPlugin()`.
 */
export const DI_WIRING: Wiring = { pkg: DI_PACKAGE, symbol: 'DiPlugin' };
