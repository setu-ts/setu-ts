/**
 * @module
 *
 * `@setu-ts/create` — the `npm create @setu-ts` entry point.
 *
 * `npm create @setu-ts my-app` runs this package's `create` executable, which
 * hands its arguments to `setu new`. It is a wrapper rather than a copy of the
 * scaffolder, so it cannot scaffold anything `setu new` would not: every flag
 * `setu new` accepts is accepted here unchanged.
 *
 * @example
 * ```bash
 * npm create @setu-ts my-app -- --template rest
 * ```
 */

/**
 * The `setu` arguments an `npm create @setu-ts` invocation stands for.
 *
 * @param argv - The arguments after the package name
 * @returns The same arguments as a `setu new` invocation
 */
export function createArgs(argv: readonly string[]): string[] {
  return ['new', ...argv];
}
