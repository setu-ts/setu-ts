/**
 * The middleware seam.
 *
 * A middleware's pipeline position is never incidental — `MiddlewareWiring.addOptions`
 * is a REQUIRED field in the template contract precisely because a bare
 * `app.middleware.add(fn())` lands at the pipeline default of 500, inside every
 * framework middleware, which is how scaffolded projects once got an `errorHandler`
 * that could not catch a throw from the metrics middleware.
 *
 * So a generated middleware carries its priority explicitly, as a constant in its OWN
 * module: the developer changes one number in a file they own, and the next
 * regeneration of this barrel picks it up rather than overwriting their choice.
 *
 * @module
 */

import type { SeamArtifacts, SeamSpec } from './seam-spec.ts';
import { assembleSeamBarrel, renderSeamImports, seamHeader, seamNames } from './seam-spec.ts';
import { deriveNames } from '../utils/names.ts';

/** Barrel export naming every generated middleware with its pipeline position. */
export const GENERATED_MIDDLEWARE_EXPORT = 'GENERATED_MIDDLEWARE';

/**
 * The name of the priority constant a generated middleware exports.
 *
 * @param screaming - The artifact's SCREAMING_SNAKE name
 * @returns The constant's identifier
 */
export function middlewarePriorityExport(screaming: string): string {
  return `${screaming}_MIDDLEWARE_PRIORITY`;
}

/**
 * Renders `src/middleware/index.ts`.
 *
 * @param artifacts - Artifact names by schematic name
 * @returns The barrel file contents
 */
function renderMiddlewareBarrel(artifacts: SeamArtifacts): string {
  const names = seamNames(artifacts, 'middleware');
  const header = seamHeader('setu generate middleware', [
    `for (const m of ${GENERATED_MIDDLEWARE_EXPORT}) {`,
    `  app.middleware.add(m.middleware, { priority: m.priority, name: m.name });`,
    `}`,
  ]);
  const imports = [
    `import type { MiddlewareFunction } from '@setu-ts/common';`,
    renderSeamImports(
      names,
      (n) => `${middlewarePriorityExport(n.screaming)}, ${n.camel}Middleware`,
      (kebab) => `./${kebab}.middleware.ts`,
    ),
  ].filter((line) => line !== '').join('\n\n');

  const entries = names.map((name) => {
    const n = deriveNames(name);
    return `{\n    name: '${n.kebab}',\n    priority: ${
      middlewarePriorityExport(n.screaming)
    },\n    middleware: ${n.camel}Middleware(),\n  }`;
  });

  return assembleSeamBarrel(header, imports, [
    `/** One generated middleware and the pipeline position its own module declares. */\n` +
    `export interface GeneratedMiddleware {\n` +
    `  /** Diagnostic name shown in pipeline introspection. */\n` +
    `  readonly name: string;\n` +
    `  /** Execution priority — lower runs earlier, so lower is outermost. */\n` +
    `  readonly priority: number;\n` +
    `  /** The middleware itself. */\n` +
    `  readonly middleware: MiddlewareFunction;\n` +
    `}`,
    `/** Every generated middleware, for \`app.middleware.add(...)\`. */\n` +
    `export const ${GENERATED_MIDDLEWARE_EXPORT}: readonly GeneratedMiddleware[] = [${
      // Always broken across lines, never `renderList`: each entry is a multi-line
      // object literal, so the single-line form the shared helper prefers would emit
      // source `deno fmt` immediately rewrites.
      entries.length === 0 ? '' : `\n  ${entries.join(',\n  ')},\n`}];`,
  ]);
}

/** The middleware seam. */
export const MIDDLEWARE_SEAM: SeamSpec = {
  schematic: 'middleware',
  dir: 'src/middleware',
  suffix: '.middleware.ts',
  barrel: 'src/middleware/index.ts',
  exports: [GENERATED_MIDDLEWARE_EXPORT],
  renderBarrel: renderMiddlewareBarrel,
};
