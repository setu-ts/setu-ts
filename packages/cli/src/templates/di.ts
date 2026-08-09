/**
 * The `--di` opt-in: the one place `DiPlugin` is named, and the one rule that
 * decides whether a template's plugin list acquires it.
 *
 * AI_GUIDELINES' "5 Optional Rules" make dependency injection optional, but
 * before this module the only way to get it from `setu new` was
 * `--template nest`, which also brings a decorated controller and an injected
 * service a developer may not want. The axis is now selectable on its own.
 *
 * @module
 */

import type { Wiring } from './registry.ts';

/** The bare `@setu-ts` package name of the DI plugin. */
const DI_PACKAGE = 'di-plugin';

/**
 * The per-project choices a template renders differently for.
 *
 * An object rather than a bare boolean because {@linkcode
 * AppFactoryWiring.args} takes it as a second parameter, where a positional
 * boolean would be unreadable at the call site — and because a later flag on
 * the same axis extends this type rather than every signature that carries it.
 */
export interface TemplateFeatures {
  /**
   * Register `DiPlugin`, so every `@Injectable` is constructed through a
   * container that honors its `scope` rather than through the kernel's
   * `ServiceRegistry`.
   */
  readonly di: boolean;
}

/** The features a `setu new` run has when no feature flag is given. */
export const DEFAULT_FEATURES: TemplateFeatures = { di: false };

/**
 * The `DiPlugin` wiring, declared once.
 *
 * `DiPlugin`'s options are optional (`di-plugin/src/plugin/di-plugin.ts:66`),
 * so no `args` string is needed and the emitted call is a bare `DiPlugin()`.
 */
export const DI_WIRING: Wiring = { pkg: DI_PACKAGE, symbol: 'DiPlugin' };

/**
 * Adds {@linkcode DI_WIRING} to a template's plugin list when `--di` is given
 * and the list does not already carry it.
 *
 * The deduplication is load-bearing rather than defensive: the kernel THROWS
 * `Duplicate plugin name 'di'` at `start()`
 * (`kernel/src/registry/plugin-resolver.ts:106`), so appending unconditionally
 * would make `setu new x --template nest --di` scaffold a project that
 * type-checks and then cannot boot. It matches on the PACKAGE rather than on
 * object identity, so a template that builds its own equivalent wiring is
 * recognized too.
 *
 * Appended rather than inserted: array position does not decide registration
 * order — the kernel resolves plugins by their declared `dependencies` — so
 * `--template rest --di` differs from `rest` by exactly one trailing entry.
 *
 * @param wirings - The template's plugin wirings
 * @param features - The per-project choices, read for `di`
 * @returns The list, with the DI wiring appended when it is wanted and absent
 */
export function withDiPlugin(
  wirings: readonly Wiring[],
  features: TemplateFeatures,
): readonly Wiring[] {
  if (!features.di) return wirings;
  if (wirings.some((wiring) => wiring.pkg === DI_PACKAGE)) return wirings;
  return [...wirings, DI_WIRING];
}
