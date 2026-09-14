// deno-lint-ignore-file no-console -- console output is sanctioned in scripts (AI_GUIDELINES §11.6)
/**
 * Verifies that every release package exists on JSR and is linked to this repository.
 *
 * ```sh
 * deno task release:verify-repos
 * ```
 *
 * `release:verify` intentionally reads only the workspace. This companion command
 * checks the JSR state that makes tag-triggered OIDC publishing possible.
 *
 * @module
 */
import { PUBLISHED_PACKAGES } from './release-packages.ts';

const API = 'https://api.jsr.io';
const SCOPE = 'setu-ts';
const OWNER = 'setu-ts';
const REPOSITORY = 'setu-ts';

interface IJsrPackage {
  readonly githubRepository?: {
    readonly owner?: string;
    readonly name?: string;
  } | null;
}

/** `packages/foo-plugin` → `foo-plugin` within the JSR scope. */
function packageName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

let failures = 0;

for (const path of PUBLISHED_PACKAGES) {
  const name = packageName(path);
  const response = await fetch(`${API}/scopes/${SCOPE}/packages/${name}`);

  if (!response.ok) {
    console.log('MISSING', name);
    failures += 1;
    continue;
  }

  const pkg = await response.json() as IJsrPackage;
  const linked = pkg.githubRepository;
  if (linked === undefined || linked === null) {
    console.log('UNLINKED', name);
    failures += 1;
  } else if (linked.owner !== OWNER || linked.name !== REPOSITORY) {
    console.log('WRONG LINK', name, `${linked.owner ?? '?'}/${linked.name ?? '?'}`);
    failures += 1;
  }
}

console.log('checked', PUBLISHED_PACKAGES.length);

if (failures > 0) Deno.exit(1);
