/** Pure npm release checks shared by the publisher and release verifier. @module */
import { workspaceProtocolSpecifiers } from './node-build-gate.ts';

/** The provenance repository identity, shared with the manifest generator. */
export const REPOSITORY_URL = 'git+https://github.com/setu-ts/setu-ts.git';

/** Narrows external JSON objects without trusting their fields. */
function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Checks the upload manifest and archive entries; source mode permits workspace:^. */
export function packedManifestProblems(
  manifest: unknown,
  expected: string,
  source = false,
  packedFiles?: readonly string[],
): readonly string[] {
  const pkg = record(manifest);
  const problems: string[] = [];
  if (typeof pkg.name !== 'string' || !/^@setu-ts\/[a-z0-9-]+$/.test(pkg.name)) {
    problems.push('name must be under @setu-ts/');
  }
  if (pkg.version !== expected) problems.push(`version must equal ${expected}`);
  if (!source) problems.push(...workspaceProtocolSpecifiers(pkg));
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const [name, range] of Object.entries(record(pkg[field]))) {
      if (name.startsWith('@setu-ts/') && range !== (source ? 'workspace:^' : `^${expected}`)) {
        problems.push(`${field}: ${name} must equal ${source ? 'workspace:^' : `^${expected}`}`);
      }
    }
  }
  if (record(pkg.repository).url !== REPOSITORY_URL) problems.push('repository.url is incorrect');
  if (record(pkg.publishConfig).access !== 'public') {
    problems.push('publishConfig.access must be public');
  }
  if (typeof pkg.license !== 'string' || pkg.license.trim() === '') {
    problems.push('license is missing');
  }
  for (const file of ['dist', 'src']) {
    if (!Array.isArray(pkg.files) || !pkg.files.includes(file)) {
      problems.push(`files must contain ${file}`);
    }
  }
  if (pkg.name !== '@setu-ts/cli' && pkg.name !== '@setu-ts/create') {
    if (!Array.isArray(pkg.files) || !pkg.files.includes('AGENT_CARD.md')) {
      problems.push('files must contain AGENT_CARD.md');
    }
    if (packedFiles !== undefined && !packedFiles.includes('package/AGENT_CARD.md')) {
      problems.push('packed library tarball is missing AGENT_CARD.md');
    }
  }
  return problems;
}

/** Release verification requires a non-empty card for every library, without exceptions. */
export function agentCardProblems(member: string, contents: string): readonly string[] {
  return member !== 'packages/cli' && member !== 'packages/create' && contents.trim() === ''
    ? [`${member}: AGENT_CARD.md is missing or empty`]
    : [];
}

/** Whether the registry explicitly lists this immutable version. */
export function packumentHasVersion(packument: unknown, version: string): boolean {
  return Object.hasOwn(record(record(packument).versions), version);
}

/** Prereleases must never replace the default release tag. */
export function distTagFor(version: string): 'latest' | 'next' {
  return version.split('+')[0].includes('-') ? 'next' : 'latest';
}

/** npm's trusted-publishing floor, verified from the actual CLI version. */
export function npmSupportsTrustedPublishing(versionText: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(versionText.trim());
  if (match === null) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  return major > 11 || (major === 11 && (minor > 5 || (minor === 5 && patch >= 1)));
}
