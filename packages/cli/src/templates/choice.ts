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
import { getTemplate, type TemplateDefinition, type TemplateHost } from './registry.ts';

/**
 * The outcome of reading the template- and style-related flags.
 *
 * A discriminated result rather than a throw: the command layer owns exit codes
 * and output sinks, and a refusal here is always a usage error.
 *
 * On success `host` is the {@linkcode TemplateHost} to render — the template
 * itself, or its precomputed class-based variant when `--style class-based`
 * was given. The caller falls back to `MINIMAL_HOST` when `host` is absent,
 * which is the no-template path.
 */
export type TemplateChoice =
  | {
    readonly ok: true;
    /** The selected template, or undefined when none was named. */
    readonly template?: TemplateDefinition;
    /** The host to render, or undefined when no template was named. */
    readonly host?: TemplateHost;
    /** An informational notice to log once, when an alias was selected. */
    readonly notice?: string;
  }
  | {
    readonly ok: false;
    /** The message to print before exiting with a usage error. */
    readonly message: string;
  };

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

/**
 * The one-line notice a selected alias carries.
 *
 * Informational only: the alias is byte-identical and is NOT deprecated, so the
 * notice names the canonical spelling without promising removal.
 *
 * @param template - The alias definition, whose `aliasOf` names the canonical form
 * @returns The notice text
 */
function aliasNotice(template: TemplateDefinition): string {
  return `--template ${template.name} is an alias of ${template.aliasOf}.`;
}

/**
 * Reads `--template` and `--style`, resolving the host to render and refusing
 * a template that does not exist, the retired independent DI switch, and every
 * style pairing that would be a silent no-op.
 *
 * The runtime target is deliberately NOT a parameter. It used to be, to refuse
 * a template/runtime pairing the template declared unsupported — but no
 * template declares one any more (`microservice` was the last, and its Workers
 * entry became a {@linkcode RuntimeSwap}), so the branch became unreachable.
 * A per-runtime difference is now expressed by swapping what a template
 * registers, in `resolveHost`, rather than by refusing the pairing here.
 *
 * Style rules: an absent `--style` means the template's own style; `--style
 * class-based` on a styleable template selects its precomputed variant; and
 * every other combination is refused with a message that names the fix.
 *
 * @param args - The parsed arguments for the verb
 * @returns The chosen template and host, or the refusal to print
 */
export function resolveTemplateChoice(args: ParsedArgs): TemplateChoice {
  if (args.flags['di'] === true) {
    return {
      ok: false,
      message:
        '`--di` is no longer supported. Use `--style class-based` (with `--template rest` or ' +
        '`--template microservice`) for decorators and DI together.',
    };
  }

  const templateFlag = stringFlag(args.flags, 'template');
  const styleFlag = stringFlag(args.flags, 'style');

  if (templateFlag === undefined) {
    // A style with no template to apply to: refused, naming the two styleable
    // templates, rather than silently ignored.
    if (styleFlag !== undefined) {
      return {
        ok: false,
        message:
          `--style applies to a styleable template: --template rest or --template microservice. ` +
          `Omit --template for the minimal set.`,
      };
    }
    return { ok: true };
  }

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

  // No style: the template's own host, plus the alias notice when there is one.
  if (styleFlag === undefined) {
    return {
      ok: true,
      template,
      host: template,
      ...(template.aliasOf === undefined ? {} : { notice: aliasNotice(template) }),
    };
  }

  // A style was given: refuse a value the axis does not have before anything
  // else, so an unknown style is never mistaken for a template problem.
  if (styleFlag !== 'functional' && styleFlag !== 'class-based') {
    return {
      ok: false,
      message: `Unknown style "${styleFlag}". Expected one of: functional, class-based.`,
    };
  }

  // A template that is neither styleable nor an alias (full-stack) composes
  // through a starter and has no controller or ingress seam for decorated
  // classes. Either style is refused there — `functional` would be a flag with no
  // effect, which is refused wherever it would be a no-op (M72).
  if (template.classBased === undefined && template.aliasOf === undefined) {
    return {
      ok: false,
      message:
        `--style ${styleFlag} cannot apply to --template ${template.name}: it composes through a ` +
        `starter and has no controller or ingress seam for decorated classes to register through.`,
    };
  }

  if (styleFlag === 'class-based') {
    // The alias IS the class-based variant of rest: redundant, accepted, and it
    // carries the alias notice like any selection of the alias.
    return template.classBased === undefined
      ? { ok: true, template, host: template, notice: aliasNotice(template) }
      : { ok: true, template, host: template.classBased };
  }

  // `--style functional`: legal on a styleable template (it IS functional), but
  // the alias has no functional form of its own — its functional spelling is
  // simply `--template rest`.
  if (template.aliasOf !== undefined) {
    return {
      ok: false,
      message: `--template ${template.name} is ${template.aliasOf}; for a functional project ` +
        `use --template rest.`,
    };
  }
  return { ok: true, template, host: template };
}
