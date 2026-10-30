/**
 * The manifests and decorator wiring shared by the templates that can host modules.
 *
 * A fresh project starts flat: its config registers `src/controllers/` and, in
 * class-based style, `src/services/`. Nothing about modules is scaffolded. The
 * first `setu g module` writes `src/modules/index.ts` and switches the config's
 * registration lines (`utils/modular-registration.ts`), so a project has one
 * layout at a time and never an empty second home for routes.
 *
 * @module
 */

import type { TemplateManifest, Wiring } from './registry.ts';
import { TEST_DEPENDENCY_MANIFEST } from './test-deps.ts';
import { SWAGGER_UI_DIST_VERSION } from './swagger-version.ts';

/**
 * Manifest additions every functional module-hosting template merges in.
 *
 * The test dependencies come from {@linkcode TEST_DEPENDENCY_MANIFEST}, which
 * every host carries now that `setu generate module` is ungated. What is added
 * here is the REST baseline's health permission and Zod schema dependency; the decorator compiler setting
 * is restricted to the class-based opt-in below.
 */
export const FUNCTIONAL_MODULE_MANIFEST: TemplateManifest = {
  ...TEST_DEPENDENCY_MANIFEST,
  // `HealthPlugin`'s `self` indicator reads `runtime.hostname()` on every probe.
  // Without this the project scaffolds, starts, and answers 500 on `/health` —
  // the path the generated Kubernetes probes point at.
  denoPermissions: ['--allow-sys', '--allow-read'],
  npmDependencies: { 'swagger-ui-dist': SWAGGER_UI_DIST_VERSION, zod: '^4.6.6' },
  denoImports: { ...TEST_DEPENDENCY_MANIFEST.denoImports, zod: 'npm:zod@^4.6.6' },
};

/** Manifest additions unique to the class-based module composition. */
export const CLASS_BASED_MODULE_MANIFEST: TemplateManifest = {
  ...FUNCTIONAL_MODULE_MANIFEST,
  // Deno needs no `denoCompilerOptions` entry for decorated classes: it parses
  // TC39 standard decorators unconfigured, so an entry here would assert a
  // setting nothing reads. (An earlier revision added that declaring ANY option
  // would REPLACE Deno's default set — false; see the M63 entry of `CLAUDE.md`.)
  // This says nothing about the other targets — Node still runs through `tsx`,
  // because V8 has not shipped decorators.
};

/**
 * Rewrites a wiring list so the `decorator-plugin` entry passes the flat
 * controller, service and ingress barrels.
 *
 * Takes the list rather than mutating a shared constant so the class-based
 * template can apply it to its own set without changing the REST baseline.
 *
 * @param wirings - The template's plugin wirings
 * @param extraControllers - Identifiers listed in the controller class list
 * @param extraServices - Identifiers listed in the service class list
 * @param extraIngress - Identifiers listed in the ingress class list
 * @returns The list with the decorator wiring's `args` replaced
 */
export function withDecoratorSeams(
  wirings: readonly Wiring[],
  extraControllers: readonly string[] = [],
  extraServices: readonly string[] = [],
  extraIngress: readonly string[] = [],
): readonly Wiring[] {
  const controllers = extraControllers.join(', ');
  const services = extraServices.join(', ');
  const ingress = extraIngress.join(', ');

  return wirings.map((wiring) =>
    wiring.pkg === 'decorator-plugin'
      ? { ...wiring, args: renderDecoratorArgs(controllers, services, ingress) }
      : wiring,
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
 * @param ingress - Rendered contents of the `ingress` array
 * @returns The argument source, without the enclosing parentheses
 */
function renderDecoratorArgs(controllers: string, services: string, ingress: string): string {
  const inline = `{ controllers: [${controllers}], services: [${services}], ingress: [${ingress}] }`;
  // 6 spaces of array indent + `DecoratorPlugin(` + `),` is 24 characters of overhead.
  if (inline.length <= 76) return inline;
  return (
    `{\n        controllers: [${controllers}],\n        services: [${services}],\n` +
    `        ingress: [${ingress}],\n      }`
  );
}
