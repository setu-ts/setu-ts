/**
 * Node module-resolution hook for test subprocesses: `@setu-ts/*` resolves to workspace source,
 * as it does inside Vitest, instead of to a member's built `dist/` (absent on a fresh checkout and
 * stale after an edit).
 *
 * @module
 */
import { pathToFileURL } from 'node:url';
import { sourceExport } from '../scripts/codemods/workspace-sources.ts';

type Resolved = { url: string; shortCircuit?: boolean };

/** Resolves workspace specifiers to source; defers everything else. */
export function resolve(
  specifier: string,
  context: unknown,
  next: (specifier: string, context: unknown) => Resolved | Promise<Resolved>,
): Resolved | Promise<Resolved> {
  const target = sourceExport(specifier);
  return target === null
    ? next(specifier, context)
    : { url: pathToFileURL(target).href, shortCircuit: true };
}
