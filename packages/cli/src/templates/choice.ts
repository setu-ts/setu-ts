/**
 * Template selection — one implementation for every verb that takes
 * `--template`.
 *
 * `setu new` and `setu generate app` both choose a template, refuse an unknown
 * name. Duplicating that would duplicate the user-facing
 * message as well as the logic (AI_GUIDELINES §11.1), and two copies of a
 * refusal drift the moment one of them is improved.
 *
 * @module
 */

import type { ParsedArgs } from '../args.ts';
import { stringFlag } from '../args.ts';
import { TEMPLATES } from '../constants.ts';
import { getTemplate, type TemplateDefinition } from './registry.ts';

/**
 * The outcome of reading the template-related flags.
 *
 * A discriminated result rather than a throw: the command layer owns exit codes
 * and output sinks, and a refusal here is always a usage error.
 */
export type TemplateChoice =
  | {
    readonly ok: true;
    /** The selected template, or undefined when none was named. */
    readonly template?: TemplateDefinition;
  }
  | {
    readonly ok: false;
    /** The message to print before exiting with a usage error. */
    readonly message: string;
  };

/**
 * Reads `--template`, refusing a template that does not exist or the retired
 * independent DI switch.
 *
 * The runtime target is deliberately NOT a parameter. It used to be, to refuse
 * a template/runtime pairing the template declared unsupported — but no
 * template declares one any more (`microservice` was the last, and its Workers
 * entry became a {@linkcode RuntimeSwap}), so the branch became unreachable.
 * A per-runtime difference is now expressed by swapping what a template
 * registers, in `resolveHost`, rather than by refusing the pairing here.
 *
 * @param args - The parsed arguments for the verb
 * @returns The chosen template, or the refusal to print
 */
/**
 * Templates that were RENAMED, and what replaced them.
 *
 * A published template name is public surface: `setu new x --template nest`
 * appears in five releases' worth of documentation and in whatever scripts
 * users wrote around it. AI_GUIDELINES §9.2 wants a deprecation rather than a
 * silent removal, and the generic unknown-name refusal is close to silent — it
 * lists four names without saying which one took over, so the reader has to
 * guess that `class-based` is the same template under a new name.
 *
 * A refusal rather than an alias: the two names would otherwise both work
 * indefinitely, and the point of the rename is that the framework does not have
 * a NestJS mode, it has a class-based one.
 */
const RENAMED_TEMPLATES: ReadonlyMap<string, string> = new Map([['nest', 'class-based']]);

export function resolveTemplateChoice(args: ParsedArgs): TemplateChoice {
  if (args.flags['di'] === true) {
    return {
      ok: false,
      message:
        '`--di` is no longer supported. Use `--template class-based` for decorators and DI together.',
    };
  }

  const templateFlag = stringFlag(args.flags, 'template');
  if (templateFlag === undefined) return { ok: true };

  // The registry lookup IS the unknown-name test: it is a `Map`, so an
  // inherited property name (`constructor`, `__proto__`) misses cleanly. A
  // separate `isTemplateName` guard in front of it would leave this branch
  // permanently unreachable — one narrowing, one refusal.
  const template = getTemplate(templateFlag);
  if (template === undefined) {
    const renamedTo = RENAMED_TEMPLATES.get(templateFlag);
    return {
      ok: false,
      message: renamedTo === undefined
        ? `Unknown template "${templateFlag}". Expected one of: ${TEMPLATES.join(', ')}.`
        : `The "${templateFlag}" template was renamed to "${renamedTo}". ` +
          `Run \`--template ${renamedTo}\` — the composition is unchanged.`,
    };
  }

  return { ok: true, template };
}
