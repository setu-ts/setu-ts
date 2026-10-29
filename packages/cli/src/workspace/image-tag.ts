/**
 * The tag `setu workspace build` and `deploy` give every member image (M122 §3.6).
 *
 * Never a fixed tag by default: the generated Deployments pull with `IfNotPresent`, so a second
 * deploy under the same tag would leave every pod on the image it already has. The default is
 * the short commit on a clean tree; with uncommitted changes it is `<commit>-dirty-<UTC time>`,
 * because two deploys of different uncommitted edits would otherwise share one tag and the second
 * would roll nothing out; outside a git repository it is a UTC timestamp.
 *
 * @module
 */

import type { CommandRunner } from '../utils/run-command.ts';

/** Docker's tag grammar: a word character first, then up to 127 of `[A-Za-z0-9_.-]`. */
const TAG_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

/**
 * Whether a tag is one Docker accepts.
 *
 * @param tag - The candidate
 * @returns Whether it matches the grammar
 */
export function isValidImageTag(tag: string): boolean {
  return TAG_PATTERN.test(tag);
}

/** `YYYYMMDDHHmmss`, UTC. */
function utcStamp(epochMs: number): string {
  return new Date(epochMs).toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

/**
 * The timestamp tag used outside a git repository: `build-YYYYMMDDHHmmss`, UTC.
 *
 * @param epochMs - Milliseconds since the epoch, from the CLI's `now`
 * @returns The tag
 */
export function timestampTag(epochMs: number): string {
  return `build-${utcStamp(epochMs)}`;
}

/**
 * Derives the default tag from the repository the workspace lives in.
 *
 * @param run - The command runner
 * @param cwd - The workspace root
 * @param now - The CLI's clock
 * @returns The short commit, `<commit>-dirty-<UTC time>` with changes, or the timestamp tag
 */
export async function defaultImageTag(
  run: CommandRunner,
  cwd: string,
  now: () => number,
): Promise<string> {
  // An inherited GIT_DIR would name another repository's commit (audit 4).
  const options = { cwd, unsetPrefixes: ['GIT_'] };
  const head = await run('git', ['rev-parse', '--short', 'HEAD'], options);
  const commit = head.stdout.trim();
  if (head.code !== 0 || !isValidImageTag(commit)) return timestampTag(now());
  const status = await run('git', ['status', '--porcelain'], options);
  return status.code === 0 && status.stdout.trim() === ''
    ? commit
    : `${commit}-dirty-${utcStamp(now())}`;
}

/**
 * The reference one member's image is built and deployed under.
 *
 * @param member - The member name, which is also the image name
 * @param tag - The tag
 * @param registry - An optional registry prefix; one trailing `/` is dropped
 * @returns `<registry>/<member>:<tag>`, or `<member>:<tag>` without a registry
 */
export function imageReference(member: string, tag: string, registry?: string): string {
  const prefix = registry === undefined ? '' : `${registry.replace(/\/$/, '')}/`;
  return `${prefix}${member}:${tag}`;
}
