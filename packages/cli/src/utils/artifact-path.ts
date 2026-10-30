/** Path identities and base-name symbols for scanned artifacts. @module */
import { deriveNames, type DerivedNames } from './names.ts';

/** Derives symbols from the filename while callers retain the relative import path. */
export function artifactNames(path: string): DerivedNames {
  return deriveNames(path.slice(path.lastIndexOf('/') + 1));
}

/**
 * Normalizes `a/./b/../c` in a project-relative, slash-separated path. A path
 * that climbs out of the project keeps its leading `..`, so it never matches a
 * project file.
 *
 * @param path - A relative path, possibly joined with a `./` or `../` specifier
 * @returns The normalized path
 */
export function normalizeRelative(path: string): string {
  const out: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..' && out.length > 0 && out.at(-1) !== '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}
