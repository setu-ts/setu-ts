/**
 * Repository links a published CLI prints, pinned to its own release tag.
 *
 * Guidance printed by an installed CLI used to name `develop`, which moves under
 * a reader who is on a release: the line could stop resolving, or resolve to a
 * file that no longer exists at that revision. A release tag is immutable, and
 * the tag a CLI prints is exactly the release it shipped in.
 *
 * @module
 */

import { VERSION } from '../constants.ts';

/**
 * Builds a `blob` URL for one repository file at this CLI's version tag.
 *
 * @param path - The repository-relative file path, with an optional `#anchor`
 * @returns The immutable URL naming the `v<version>` tag
 */
export function repositoryFileUrl(path: string): string {
  return `https://github.com/setu-ts/setu-ts/blob/v${VERSION}/${path}`;
}
