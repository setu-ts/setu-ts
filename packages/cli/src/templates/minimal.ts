/**
 * The host used when `setu new` is given no `--template`.
 *
 * A project scaffolded with no template registers the runtime plugin alone —
 * no decorators, no DI container. That is the shape AI_GUIDELINES' "5 Optional
 * Rules" describe when they say the framework must work without either, and
 * `setu generate route` is the only HTTP handler it can generate.
 *
 * Before this module that route landed UNWIRED: the schematic wrote
 * `src/routes/<name>.routes.ts` and a `src/routes/index.ts` barrel exporting
 * `registerGeneratedRoutes`, while the generated `setu.config.ts` never called
 * it. The decorator-free path therefore needed a hand edit that the three
 * decorated templates did not — which is the promise being false in exactly
 * the project shape it is loudest about.
 *
 * The seams come from {@linkcode seamsFor}, not from a list here, so this host
 * can never carry a seam whose plugin it does not register. With the runtime
 * plugin alone that selects `route`, `middleware` and `plugin` — the three that
 * declare no `requiresPlugin` — and none of them is inert.
 *
 * @module
 */

import type { SeamSpec } from '../seams/seam-spec.ts';
import type { TemplateHost } from './registry.ts';
import { RUNTIME_WIRING } from './rest.ts';
import {
  seamFiles,
  seamLocalImports,
  seamPluginSpreads,
  seamSetupCalls,
  seamsFor,
} from './seam.ts';

/**
 * The seams a runtime-plugin-only project can consume.
 *
 * Exported for its own unit test, and read by {@linkcode MINIMAL_HOST} below.
 */
export const MINIMAL_SEAMS: readonly SeamSpec[] = seamsFor(new Set([RUNTIME_WIRING.pkg]));

/**
 * The no-template host: the runtime plugin, plus the seams that need no plugin.
 *
 * Deliberately not a {@linkcode TemplateDefinition} and not a member of the
 * template registry — it has no `--template` value, so `new --help` still lists
 * exactly the four templates that exist, and `--template minimal` is still an
 * unknown value rather than an undocumented fifth option.
 *
 * `middleware` is empty because `errorHandler` comes from `@setu-ts/exceptions`,
 * which the minimal project does not depend on; a generated middleware still
 * reaches the pipeline through the `middleware` seam's own setup call.
 */
export const MINIMAL_HOST: TemplateHost = {
  plugins: [RUNTIME_WIRING],
  middleware: [],
  localImports: seamLocalImports(MINIMAL_SEAMS),
  files: seamFiles(MINIMAL_SEAMS),
  pluginSpreads: seamPluginSpreads(MINIMAL_SEAMS),
  setupCalls: seamSetupCalls(MINIMAL_SEAMS),
};
