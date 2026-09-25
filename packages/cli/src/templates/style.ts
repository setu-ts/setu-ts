/**
 * The style axis — one recipe, two hosts.
 *
 * Before this milestone the style and the plugin set were one choice: `rest`
 * and `microservice` were functional, and `class-based` was the REST set plus
 * the decorator and DI pair. A NestJS team migrating a microservice had no
 * scaffold, because no template carried both the microservice plugins and the
 * decorators.
 *
 * This module makes style its own axis. A styleable template module exports one
 * {@linkcode TemplateRecipe} — the pre-seam plugin list, middleware, manifest
 * base, runtime swaps and a per-style showcase — and {@linkcode composeHost}
 * builds the host for either style from it. Precomputing the host (rather than
 * transforming a finished {@linkcode TemplateDefinition}) is what keeps
 * `--dry-run` exact and lets a test assert a variant without rendering a
 * project, the same reasoning as {@linkcode RuntimeSwap}. It is also what makes
 * `class-based` and `rest --style class-based` identical by construction.
 *
 * @module
 */
import type { TargetRuntime } from '../constants.ts';
import type { GeneratedFile } from '../utils/file-writer.ts';
import type { SeamArtifacts } from '../seams/seam-spec.ts';
import type {
  MiddlewareWiring,
  RuntimeSwap,
  TemplateHost,
  TemplateManifest,
  Wiring,
} from './registry.ts';
import { DI_WIRING } from './di.ts';
import {
  CLASS_BASED_MODULE_MANIFEST,
  MODULE_SEAM_FILES,
  MODULE_SEAM_LOCAL_IMPORT,
  withModuleSeam,
} from './module-seam.ts';
import {
  decoratorSeamExtras,
  seamFiles,
  seamLocalImports,
  seamPluginSpreads,
  seamSetupCalls,
  seamsFor,
  withPluginOptionSeams,
} from './seam.ts';

/** The code style a styleable template can be scaffolded in. */
export type TemplateStyle = 'functional' | 'class-based';

/** The bare `@setu-ts` package that marks a project as class-based. */
const DECORATOR_PACKAGE = 'decorator-plugin';

/**
 * The decorator wiring, declared once.
 *
 * The class-based style always installs the decorator and DI pair together —
 * `DiPlugin` is what moves every `@Injectable` onto a container provider that
 * honors its `scope`, and without it the classes still work but resolved from
 * the kernel's `ServiceRegistry`. Keeping the pair in one place is the M65
 * property the docs protect.
 */
export const DECORATOR_WIRING: Wiring = { pkg: DECORATOR_PACKAGE, symbol: 'DecoratorPlugin' };

/**
 * The example artifacts a template emits in one style.
 *
 * Files plus the seeded seam names: the showcase lives in the seam directories
 * and is seeded into the scaffolded barrels so it is registered the same way a
 * generated artifact is (E4).
 */
export interface Showcase {
  /** The example source files, project-relative. */
  readonly files: readonly GeneratedFile[];
  /** Artifact names the host itself emits, by schematic name, seeded into barrels. */
  readonly seeded: SeamArtifacts;
}

/**
 * Everything a styleable template needs, before seams are derived.
 *
 * The seams, seam barrels and plugin `args` are DERIVED by {@linkcode composeHost}
 * from this data, so a template cannot acquire a barrel the config does not
 * import, or an import the barrel does not export.
 */
export interface TemplateRecipe {
  /** The pre-seam plugin list, in registration order. */
  readonly plugins: readonly Wiring[];
  /** Middleware added with `app.middleware.add(...)` after construction. */
  readonly middleware: readonly MiddlewareWiring[];
  /** The functional manifest base; the class-based variant uses the class-based one. */
  readonly manifest: TemplateManifest;
  /** Per-runtime replacements, shared by both styles. */
  readonly runtimeSwaps?: Readonly<Partial<Record<TargetRuntime, RuntimeSwap>>>;
  /** The per-style showcase, when the style emits example artifacts of its own. */
  readonly showcase?: {
    readonly functional?: Showcase;
    readonly 'class-based'?: Showcase;
  };
}

/**
 * Builds a host for one style from a recipe.
 *
 * The functional arm reproduces today's `rest` and `microservice` construction;
 * the class-based arm adds the decorator and DI pair, the module seam, and the
 * class-based manifest, and derives every seam from the WIDENED package set so
 * the decorator families (controller, service, ingress) are present.
 *
 * @param recipe - The styleable template's data
 * @param style - The code style to compose
 * @returns The host to render
 */
export function composeHost(recipe: TemplateRecipe, style: TemplateStyle): TemplateHost {
  if (style === 'class-based') {
    const installed = new Set([...recipe.plugins.map((p) => p.pkg), DECORATOR_PACKAGE]);
    const seams = seamsFor(installed);
    const extras = decoratorSeamExtras(seams);
    const showcase = recipe.showcase?.['class-based'];
    return {
      plugins: withPluginOptionSeams(
        withModuleSeam(
          [...recipe.plugins, DECORATOR_WIRING],
          extras.controllers,
          extras.services,
          extras.ingress,
        ),
        seams,
      ).concat([DI_WIRING]),
      middleware: recipe.middleware,
      localImports: [MODULE_SEAM_LOCAL_IMPORT, ...seamLocalImports(seams)],
      files: [
        ...(showcase?.files ?? []),
        ...MODULE_SEAM_FILES,
        ...seamFiles(seams, showcase?.seeded ?? {}),
      ],
      pluginSpreads: seamPluginSpreads(seams),
      setupCalls: seamSetupCalls(seams),
      manifest: { ...CLASS_BASED_MODULE_MANIFEST, envFilePath: '.env' },
      ...(recipe.runtimeSwaps === undefined ? {} : { runtimeSwaps: recipe.runtimeSwaps }),
    };
  }

  const installed = new Set(recipe.plugins.map((p) => p.pkg));
  const seams = seamsFor(installed);
  const showcase = recipe.showcase?.functional;
  return {
    plugins: withPluginOptionSeams(recipe.plugins, seams),
    middleware: recipe.middleware,
    localImports: seamLocalImports(seams),
    files: [...(showcase?.files ?? []), ...seamFiles(seams, showcase?.seeded ?? {})],
    pluginSpreads: seamPluginSpreads(seams),
    setupCalls: seamSetupCalls(seams),
    manifest: { ...recipe.manifest, envFilePath: '.env' },
    ...(recipe.runtimeSwaps === undefined ? {} : { runtimeSwaps: recipe.runtimeSwaps }),
  };
}
