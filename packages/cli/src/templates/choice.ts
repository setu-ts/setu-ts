/**
 * Template selection — one implementation for every verb that takes
 * `--template`.
 *
 * `setu new` and `setu generate app` both choose a template, refuse an unknown
 * name, and read `--di`. Duplicating that would duplicate the user-facing
 * message as well as the logic (AI_GUIDELINES §11.1), and two copies of a
 * refusal drift the moment one of them is improved.
 *
 * @module
 */

import type { ParsedArgs } from '../args.ts';
import { stringFlag } from '../args.ts';
import { TEMPLATES } from '../constants.ts';
import { getTemplate, type TemplateDefinition, type TemplateFeatures } from './registry.ts';

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
    /** The per-project choices the renderer branches on. */
    readonly features: TemplateFeatures;
  }
  | {
    readonly ok: false;
    /** The message to print before exiting with a usage error. */
    readonly message: string;
  };

/**
 * Reads `--template` and `--di`, refusing a template that does not exist.
 *
 * The runtime target is deliberately NOT a parameter. It used to be, to refuse
 * a template/runtime pairing the template declared unsupported — but no
 * template declares one any more (`microservice` was the last, and its Workers
 * entry became a {@linkcode RuntimeSwap}), so the branch became unreachable.
 * A per-runtime difference is now expressed by swapping what a template
 * registers, in `resolveHost`, rather than by refusing the pairing here.
 *
 * @param args - The parsed arguments for the verb
 * @returns The chosen template and features, or the refusal to print
 */
export function resolveTemplateChoice(args: ParsedArgs): TemplateChoice {
  // Read once, here, so the flag cannot be honored by one renderer and ignored
  // by another. `--di` is boolean: it is absent from VALUE_FLAGS, so `parseArgs`
  // records it as `true` rather than consuming the next token.
  const features: TemplateFeatures = { di: args.flags['di'] === true };

  const templateFlag = stringFlag(args.flags, 'template');
  if (templateFlag === undefined) return { ok: true, features };

  // The registry lookup IS the unknown-name test: it is a `Map`, so an
  // inherited property name (`constructor`, `__proto__`) misses cleanly. A
  // separate `isTemplateName` guard in front of it would leave this branch
  // permanently unreachable — one narrowing, one refusal.
  const template = getTemplate(templateFlag);
  if (template === undefined) {
    return {
      ok: false,
      message: `Unknown template "${templateFlag}". Expected one of: ${TEMPLATES.join(', ')}.`,
    };
  }

  return { ok: true, template, features };
}
