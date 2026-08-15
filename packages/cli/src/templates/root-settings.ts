/**
 * The settings a generated ROOT manifest carries — a standalone project's
 * `deno.json`, or a workspace root's.
 *
 * One definition read by both emitters, so a scaffolded workspace and a
 * scaffolded single project cannot disagree about how their source is formatted
 * or which dependency versions they are allowed to resolve.
 *
 * Root-only by construction: a workspace MEMBER inherits both from its root, and
 * Deno rejects some root settings outright in a member manifest.
 *
 * @module
 */

/**
 * The formatting a generated project inherits.
 *
 * These are the framework repo's own `fmt` settings. Emitting them is not a
 * style preference — the CLI writes single-quoted TypeScript while Deno's
 * default is double, so a project scaffolded without this fails
 * `deno fmt --check` on the files the CLI itself just wrote.
 */
const FMT_SETTINGS = {
  lineWidth: 100,
  indentWidth: 2,
  singleQuote: true,
  semiColons: true,
} as const;

/**
 * Why a generated project opts out of the minimum-dependency-age policy.
 *
 * Emitted as a sibling comment key so the reason travels with the setting: a
 * reader who deletes the line should know what breaks.
 */
const MIN_DEP_AGE_NOTE =
  'setu pins this project to the CLI version that generated it. Deno refuses a ' +
  'dependency published in the last 24 hours, so without this a project scaffolded ' +
  'on the day of a release cannot install the versions it was just pinned to.';

/**
 * Builds the settings block a generated root manifest carries.
 *
 * @param buildOutputDir - Where a frontend build writes, when the template has
 * one. Excluded from `fmt` and `lint`: both walk the project tree, and a
 * minified bundle is neither formattable nor lintable — `deno fmt` reformatting
 * one is what D2 reported.
 * @returns The keys to merge into the emitted `deno.json`, in a fixed order so
 * the generated file is byte-identical across runs
 */
export function rootManifestSettings(
  buildOutputDir?: string,
): Readonly<Record<string, unknown>> {
  const exclude = buildOutputDir === undefined ? {} : {
    fmt: { ...FMT_SETTINGS, exclude: [buildOutputDir] },
    lint: { exclude: [buildOutputDir] },
  };
  return {
    '//minimumDependencyAge': MIN_DEP_AGE_NOTE,
    minimumDependencyAge: 0,
    fmt: FMT_SETTINGS,
    ...exclude,
  };
}
