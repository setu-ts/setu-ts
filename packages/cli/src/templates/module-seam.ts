/**
 * The domain-module barrel seam shared by the templates that can host modules.
 *
 * A scaffolded project imports the two barrel arrays into `setu.config.ts` and
 * hands them to `DecoratorPlugin`, so `setu generate module` wires a module in by
 * regenerating one CLI-owned file and never editing the developer's config.
 *
 * Emitted from scaffold time, deliberately: a project that gains the seam only
 * once its first module is generated would need `setu.config.ts` edited at that
 * moment, which is the write this whole design exists to avoid.
 *
 * @module
 */

import type { GeneratedFile } from '../utils/file-writer.ts';
import { MODULES_DIR } from '../utils/module-scanner.ts';
import { MODULES_EXPORT, renderModuleBarrel } from '../schematics/module-barrel.ts';
import type { LocalImport, TemplateManifest, Wiring } from './registry.ts';
import { TEST_DEPENDENCY_MANIFEST } from './test-deps.ts';

/** Specifier the generated `setu.config.ts` imports the barrel from. */
const BARREL_SPECIFIER = `./${MODULES_DIR}/index.ts`;

/**
 * Manifest additions every functional module-hosting template merges in.
 *
 * The test dependencies come from {@linkcode TEST_DEPENDENCY_MANIFEST}, which
 * every host carries now that `setu generate module` is ungated. What is added
 * here is the REST baseline's health permission; the decorator compiler setting
 * is restricted to the class-based opt-in below.
 */
export const FUNCTIONAL_MODULE_MANIFEST: TemplateManifest = {
  ...TEST_DEPENDENCY_MANIFEST,
  // `HealthPlugin`'s `self` indicator reads `runtime.hostname()` on every probe.
  // Without this the project scaffolds, starts, and answers 500 on `/health` —
  // the path the generated Kubernetes probes point at.
  denoPermissions: ['--allow-sys'],
};

/** Manifest additions unique to the class-based module composition. */
export const CLASS_BASED_MODULE_MANIFEST: TemplateManifest = {
  ...FUNCTIONAL_MODULE_MANIFEST,
  // Deno needs no `denoCompilerOptions` entry for decorated classes: it parses
  // TC39 standard decorators unconfigured, and declaring ANY option would
  // REPLACE its default set (M63 D3), so adding nothing is both correct and the
  // safer default. This says nothing about the other targets — Node still runs
  // through `tsx`, because V8 has not shipped decorators.
};

/**
 * The empty aggregate barrel a fresh project starts with.
 *
 * Rendered by the same function `setu generate module` uses, so the scaffolded
 * file and every regeneration of it can never drift apart in shape.
 */
export const MODULE_SEAM_FILES: readonly GeneratedFile[] = [
  { path: `${MODULES_DIR}/index.ts`, contents: renderModuleBarrel([]) },
];

/** The `setu.config.ts` import that brings the activation barrel into scope. */
export const MODULE_SEAM_LOCAL_IMPORT: LocalImport = {
  symbols: [MODULES_EXPORT],
  from: BARREL_SPECIFIER,
};

/**
 * Rewrites a wiring list so the `decorator-plugin` entry passes the barrel
 * activation list, alongside standalone controller and service seam entries.
 *
 * Takes the list rather than mutating a shared constant so the class-based
 * template can apply it to its own set without changing the REST baseline.
 *
 * @param wirings - The template's plugin wirings
 * @param extraControllers - Identifiers listed before the barrel spread
 * @param extraServices - Identifiers listed before the barrel spread
 * @returns The list with the decorator wiring's `args` replaced
 */
export function withModuleSeam(
  wirings: readonly Wiring[],
  extraControllers: readonly string[] = [],
  extraServices: readonly string[] = [],
): readonly Wiring[] {
  const controllers = extraControllers.join(', ');
  const services = extraServices.join(', ');

  return wirings.map((wiring) =>
    wiring.pkg === 'decorator-plugin'
      ? { ...wiring, args: renderDecoratorArgs(controllers, services) }
      : wiring
  );
}

/**
 * Renders the decorator wiring's argument object, breaking onto lines when the
 * single-line form would run long.
 *
 * Wrapping matters because the emitted `setu.config.ts` is a file a developer opens and
 * edits: once the standalone-controller and standalone-service barrels join the module
 * ones, the inline form runs past 110 characters inside the plugin array.
 *
 * The indentation is absolute rather than relative — `Wiring.args` is rendered verbatim
 * into an array entry the renderer has already indented by six spaces, so a
 * continuation line has to carry its own eight and the closing brace its own six.
 *
 * @param controllers - Rendered contents of the `controllers` array
 * @param services - Rendered contents of the `services` array
 * @returns The argument source, without the enclosing parentheses
 */
function renderDecoratorArgs(controllers: string, services: string): string {
  const inline =
    `{ controllers: [${controllers}], services: [${services}], modules: [...${MODULES_EXPORT}] }`;
  // 6 spaces of array indent + `DecoratorPlugin(` + `),` is 24 characters of overhead.
  if (inline.length <= 76) return inline;
  return `{\n        controllers: [${controllers}],\n        services: [${services}],\n` +
    `        modules: [...${MODULES_EXPORT}],\n      }`;
}
