/**
 * The shell's logical working directory, when it is trustworthy.
 *
 * `process.cwd()` is physical: inside a symlinked directory it names the link
 * target, so a workspace above the link is invisible. `$PWD` keeps the path the
 * shell used. It is used only when it is absolute and resolves to the SAME real
 * path as `cwd` — a stale or forged value fails that test and is omitted.
 *
 * Kept out of `main.ts` so the documented `@setu-ts/cli/main` exports stay
 * exactly the process boundary's; the only reader is `main.ts` itself.
 *
 * @module
 */

import { realpathSync } from 'node:fs';
import process from 'node:process';

/**
 * Returns the shell's logical working directory, or undefined when it cannot
 * be trusted.
 *
 * @param cwd - The physical working directory
 * @returns The logical path, or undefined when `$PWD` cannot be trusted
 */
export function logicalCwdFor(cwd: string): string | undefined {
  const pwd = process.env['PWD'];
  if (pwd === undefined || !pwd.startsWith('/')) return undefined;
  try {
    return realpathSync(pwd) === realpathSync(cwd) ? pwd : undefined;
  } catch {
    return undefined;
  }
}
