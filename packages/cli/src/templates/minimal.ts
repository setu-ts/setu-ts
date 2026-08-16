/**
 * The host used when `setu new` is given no `--template`.
 *
 * A project scaffolded with no template registers the runtime plugin alone —
 * no decorators, no DI container. That is the shape AI_GUIDELINES' "5 Optional
 * Rules" describe when they say the framework must work without either, and
 * `setu generate route` and `setu generate controller` both emit an HTTP handler
 * it can generate — `controller` is ungated since M70h and emits the functional
 * shape here, so neither requires decorators.
 *
 * Before this module that route landed UNWIRED: the schematic wrote
 * `src/routes/<name>.routes.ts` and a `src/routes/index.ts` barrel exporting
 * (both since merged into `src/controllers/` by E8)
 * `registerGeneratedRoutes`, while the generated `setu.config.ts` never called
 * it. The decorator-free path therefore needed a hand edit that the three
 * decorated templates did not — which is the promise being false in exactly
 * the project shape it is loudest about.
 *
 * The seams come from {@linkcode seamsFor}, not from a list here, so this host
 * can never carry a seam whose plugin it does not register. With the runtime
 * plugin alone that selects `route`, `controller`, `middleware` and `plugin`,
 * and none of them is inert. `controller` is there by the generator-mode swap in
 * `seams/registry.ts` rather than by declaring no `requiresPlugin` — the
 * class-based spec still declares one — which is why this list is derived rather
 * than written out.
 *
 * @module
 */

import type { SeamSpec } from '../seams/seam-spec.ts';
import type { TemplateHost } from './registry.ts';
import { RUNTIME_WIRING } from './rest.ts';
import { TEST_DEPENDENCY_MANIFEST } from './test-deps.ts';
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
  manifest: {
    // `setu generate module` is ungated since M65, so this host can emit a
    // `*.service.test.ts` — and a host that emits a test file must declare the
    // packages it imports, or the first `deno test` fails on an import the CLI
    // itself wrote.
    ...TEST_DEPENDENCY_MANIFEST,
    // Kept even though nothing this host emits is decorated: a developer who
    // adds `@setu-ts/decorator-plugin` by hand would otherwise get a compile
    // error from a manifest they did not write. It is free here in a way it is
    // NOT on the full-stack template — declaring any compiler option replaces
    // Deno's default set, which is how the fixed `experimentalDecorators`
    // silently disabled `jsx` there.
    denoCompilerOptions: { experimentalDecorators: true },
    // No extra permissions: this host registers only the runtime plugin, so it
    // has no health indicator reading the hostname and no server build to read.
  },
};
