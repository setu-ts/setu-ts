/** The addable packages a brief lists as not installed: one predicate for the list and the rule. */
import { ADDABLE, RUNTIME_RESTRICTIONS } from '../commands/add.ts';
import type { ProjectFacts } from './facts.ts';

/**
 * Lists `[addName, package]` for each addable package absent from the project and allowed on its
 * runtime, in `ADDABLE` order.
 *
 * @param facts - The project facts the brief is rendered from
 * @returns The add name and package of every package the brief lists as not installed
 */
export function notInstalledAddables(facts: ProjectFacts): readonly (readonly [string, string])[] {
  const absent: (readonly [string, string])[] = [];
  for (const [name, { pkg }] of ADDABLE) {
    const restriction = RUNTIME_RESTRICTIONS.get(pkg);
    if (facts.installed.has(pkg)) continue;
    if (restriction !== undefined && !restriction.runtimes.includes(facts.runtime)) continue;
    absent.push([name, pkg]);
  }
  return absent;
}
