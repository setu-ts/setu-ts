/**
 * The interactive question set for `setu new`.
 *
 * Prompting REWRITES FLAG VALUES and then the existing pipeline runs unchanged:
 * `planWorkspace` and `planProject` stay pure functions of their arguments, so
 * `--dry-run` remains exact — what is printed is what would be written — and
 * every prompted value is expressible as a flag, which is the constraint that
 * keeps prompts from becoming a second way to configure a project.
 *
 * Questions are asked only for a flag that is ABSENT, only when `--yes` is
 * absent (checked by the caller), and only when a prompter was supplied at all.
 * The broker and queue questions are asked only when the answers already
 * collected make the flag LEGAL under the same predicate the command refuses
 * on (`standaloneOverlayRefusal`), so asking a question whose answer would then
 * be refused cannot happen.
 *
 * @module
 */
import type { ParsedArgs } from '../args.ts';
import { isTargetRuntime, TARGET_RUNTIMES, type TargetRuntime } from '../constants.ts';
import type { PromptChoice, Prompter } from '../prompt.ts';
import { standaloneOverlayRefusal } from '../templates/broker.ts';
import { MINIMAL_HOST } from '../templates/minimal.ts';
import { type ResolvedHost, resolveHost } from '../templates/project-files.ts';
import { getTemplate, listTemplates } from '../templates/registry.ts';
import { getTransport, listBrokers, listQueues, listTransports } from '../workspace/transport.ts';

/**
 * The interactive template prompt's default arm.
 *
 * Bare Enter takes the FIRST choice offered, and {@linkcode listTemplates}
 * starts with `rest` — but the documented default (what `--yes` takes, and
 * what a non-terminal takes) is NO `--template` flag, which the pipeline
 * resolves through `choice.template ?? MINIMAL_HOST`. So the prompt spells its
 * own default arm FIRST and selecting it records nothing, making Enter produce
 * exactly what `--yes` produces regardless of registry ordering. It is
 * deliberately not a registry name — `getTemplate('minimal')` is undefined —
 * which is why the arm is consumed here rather than written into the flag.
 */
const TEMPLATE_PROMPT_DEFAULT = 'minimal';

/**
 * The host a standalone project would render with, given the answers so far.
 *
 * Shared by the broker/queue eligibility checks: the predicate §3.4 refuses on
 * reads the RESOLVED host — post-runtime-swap — because that is where the
 * Workers swap has already removed the wiring a broker arm would rewrite.
 *
 * @param templateFlag - The collected `--template` value, when any
 * @param runtime - The collected `--runtime` value
 * @returns The resolved host, or undefined when the answers name no template
 */
function standaloneHost(templateFlag: string, runtime: TargetRuntime): ResolvedHost | undefined {
  const template = getTemplate(templateFlag);
  return template === undefined ? undefined : resolveHost(template, runtime);
}

/**
 * Asks the questions whose answers the caller omitted, and returns the flags
 * with the answers filled in.
 *
 * A `select` that resolves undefined — stdin not a terminal, or mid-session EOF
 * — leaves THAT flag absent and still asks the rest; the pipeline then applies
 * each documented default exactly as if the prompt had never existed.
 *
 * @param args - The parsed arguments
 * @param prompter - The prompt seam; when absent, nothing is ever asked
 * @param log - Echoes each accepted answer as normal output
 * @returns A NEW argument record carrying the answers
 */
export async function resolveNewChoices(
  args: ParsedArgs,
  prompter: Prompter | undefined,
  log: (message: string) => void,
): Promise<ParsedArgs> {
  // The PRIMARY non-interactive guarantee lives at the call site (`ask` is
  // optional and no gate passes it); this guard is the same promise restated
  // for direct callers of this module.
  if (prompter === undefined) return args;

  const flags: Record<string, string | boolean | readonly string[]> = { ...args.flags };
  const workspace = args.flags['workspace'] === true;
  // Narrowed once for the closure below; the guard above already returned.
  const select = prompter;

  /**
   * Asks one question for an absent flag and records the answer.
   *
   * @param flag - The flag the answer stands in for
   * @param question - The question text
   * @param choices - The acceptable answers, first being the default
   */
  async function ask(
    flag: string,
    question: string,
    choices: readonly PromptChoice[],
  ): Promise<void> {
    if (flags[flag] !== undefined) return;
    const answer = await select.select(question, choices);
    if (answer === undefined) return;
    flags[flag] = answer;
    log(`${question} ${answer}`);
  }

  await ask(
    'runtime',
    'Runtime?',
    TARGET_RUNTIMES.map((name) => ({ value: name, label: `Target ${name}` })),
  );

  if (workspace) {
    await ask(
      'transport',
      'How should the workspace members reach each other?',
      listTransports().map((spec) => ({ value: spec.name, label: spec.description })),
    );
    return { positionals: args.positionals, flags };
  }

  // The template question does not go through `ask`: its default arm is NOT
  // the first registry entry. Enter must yield the same scaffold `--yes`
  // yields, which is an ABSENT flag resolved to MINIMAL_HOST downstream —
  // see TEMPLATE_PROMPT_DEFAULT.
  if (flags['template'] === undefined) {
    const answer = await select.select('Template?', [
      {
        value: TEMPLATE_PROMPT_DEFAULT,
        label: 'Runtime plugin alone — the scaffold --yes produces',
      },
      ...listTemplates().map((template) => ({
        value: template.name,
        label: template.description,
      })),
    ]);
    if (answer !== undefined) {
      // The default arm records NOTHING: an absent flag is exactly how the
      // pipeline — and `--yes` — reach MINIMAL_HOST.
      if (answer !== TEMPLATE_PROMPT_DEFAULT) flags['template'] = answer;
      log(`Template? ${answer}`);
    }
  }

  // The broker and queue questions fire only when the collected answers make
  // the flag legal — derived from the SAME refusal the command enforces, so a
  // prompt whose answer would be refused cannot be asked. An unknown template
  // name skips them here; the pipeline refuses it below with its own message.
  const rawRuntime = flags['runtime'];
  const runtime = typeof rawRuntime === 'string' && isTargetRuntime(rawRuntime)
    ? rawRuntime
    : 'deno';
  const rawTemplate = flags['template'];
  const host = typeof rawTemplate === 'string'
    ? standaloneHost(rawTemplate, runtime)
    : resolveHost(MINIMAL_HOST, runtime);

  if (host !== undefined) {
    if (standaloneOverlayRefusal('broker', runtime, host) === undefined) {
      await ask(
        'broker',
        'Message broker?',
        listBrokers().map((name) => ({
          value: name,
          label: getTransport(name)?.description ?? name,
        })),
      );
    }
    if (standaloneOverlayRefusal('queue', runtime, host) === undefined) {
      await ask(
        'queue',
        'Job queue?',
        listQueues().map((name) => ({
          value: name,
          label: getTransport(name)?.description ?? name,
        })),
      );
    }
  }

  return { positionals: args.positionals, flags };
}
