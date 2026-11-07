/**
 * Repository links a published CLI prints, pinned to its own release tag.
 *
 * Guidance printed by an installed CLI used to name `develop`, which moves under
 * a reader who is on a release: the line could stop resolving, or resolve to a
 * file that no longer exists at that revision. A release tag is immutable, and
 * the tag a CLI prints is exactly the release it shipped in.
 *
 * {@linkcode siteUrl} is the other half: generated READMEs link the rendered
 * site, which carries the same guides as pages and works for a reader with no
 * GitHub access (X93-7).
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

/**
 * Builds a URL on the public site for a rendered page or file.
 *
 * @param path - The site-relative path, for example `docs/cli/`; empty for the home page
 * @returns The absolute site URL, with a trailing slash when `path` is empty
 */
export function siteUrl(path: string): string {
  return `https://setu-ts.dev/${path.replace(/^\/+/, '')}`;
}
