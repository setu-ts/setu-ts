/**
 * Determines which coherent application style a generated project uses.
 *
 * @module
 */

/** The two generated application styles. */
export type GeneratorMode = 'functional' | 'class-based';

/**
 * Determines the generator mode from the packages persisted in a project's manifest.
 *
 * @param plugins - Bare `@setu-ts` package names detected in the target project
 * @returns `class-based` for a project that can consume decorator output,
 * otherwise `functional`
 *
 * New projects always select a coherent pair through `--template class-based`.
 * Existing projects may have installed `decorator-plugin` independently before
 * that template existed; keep their generated classes working rather than
 * turning a generation command into an avoidable migration failure.
 */
export function generatorMode(plugins: ReadonlySet<string>): GeneratorMode {
  return plugins.has('decorator-plugin') ? 'class-based' : 'functional';
}
