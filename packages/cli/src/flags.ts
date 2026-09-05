/**
 * The per-command flag inventory and the unknown-option refusal.
 *
 * [`parseArgs`](./args.ts) collects every `--flag` into a record and never
 * consults the valid names — [`VALUE_FLAGS`](./constants.ts) only marks which
 * flags consume the following token, it is NOT an allowlist. A typo therefore
 * used to be silently ignored: `setu new app --dry-run --templat rest`
 * scaffolded the minimal project with exit 0 and no warning, and a bare
 * `--totally-bogus-flag` was swallowed the same way.
 *
 * The positional twin lives here too: `new` read one name and `generate` read
 * at most a schematic and a name, silently dropping the rest — `setu new app
 * extra junk` scaffolded `app` and reported success — and the zero-positional
 * commands (`adopt`, `workspace ports`, `commands`, `help`) dropped everything.
 * The inventory carries each command's positional contract and the dispatcher
 * refuses an over-arity invocation the same way: exit 2, message on the error
 * sink, nothing written or created, before any command body runs.
 *
 * This module owns the inventory — what each command's `--help` text documents,
 * plus the flags a command deliberately READS in order to refuse with specific
 * guidance — and the refusals that run in the dispatcher before any command
 * body. The plugin-command arm's check lives in `dispatchPluginCommand`
 * ([`plugin-commands.ts`](./commands/plugin-commands.ts)), which refuses an
 * unknown flag after the config module is confirmed and BEFORE the application
 * is loaded and started — a typo'd flag never boots the project.
 *
 * Nothing here is exported from `src/index.ts`: this is internal dispatcher
 * machinery, read by [`cli.ts`](./cli.ts),
 * [`plugin-commands.ts`](./commands/plugin-commands.ts), and the committed
 * help↔inventory gate in `test/unit/flags.test.ts`.
 *
 * @module
 */

import { EXIT_USAGE, PROGRAM_NAME } from './constants.ts';

/**
 * The flags every built-in command answers to, each handled inside the command
 * itself (`--help` is never an error in any of them).
 *
 * `version`/`v` are deliberately absent: `runCli` consumes them before
 * dispatch — `setu new app --version` prints the version — so they can never
 * reach this check.
 */
const GLOBAL_FLAGS: readonly string[] = ['help', 'h'];

/**
 * The flags a plugin-registered command may carry: exactly what its dispatcher
 * consumes (`--dir`, `--config`) and nothing more.
 *
 * A plugin command cannot read any other flag today — `CliCommandHandler` is
 * `(args: readonly string[]) => …` in `@setu-ts/common`, and
 * `dispatchPluginCommand` calls `match.handler(args.positionals)` — so refusing
 * the rest is pure typo protection with zero breakage. There is no `--help`
 * handling for plugin commands either, so unlike the built-ins the global help
 * flags are not in this set.
 */
export const PLUGIN_COMMAND_FLAGS: readonly string[] = ['dir', 'config'];

/**
 * One built-in command's positional contract: the arguments it consumes after
 * its fixed words (the verb and any subcommand word), and what they are for
 * the refusal message.
 */
export interface ICommandPositionals {
  /**
   * Leading positionals that are part of the command's own shape — the verb,
   * plus the subcommand word when the command has one (`generate app`).
   * Counted against the FULL positional array, the way `runCli` sees it.
   */
  readonly fixed: number;
  /** How many arguments the command consumes after those. */
  readonly taken: number;
  /** What the consumed arguments are, phrased with their count. */
  readonly noun: string;
}

/** One built-in command's flag and positional inventory. */
export interface ICommandFlagSpec {
  /** How the command reads in refusal messages (`new`, `generate app`). */
  readonly label: string;
  /** Every flag name the invocation may carry — the strict allowlist. */
  readonly allowed: readonly string[];
  /**
   * The flags the command's own `--help` text presents as options, the global
   * help flags excepted. The help↔inventory gate in `test/unit/flags.test.ts`
   * asserts the rendered help text against exactly this set in BOTH directions.
   * Empty for entries with no `--help` surface of their own (`setu commands`,
   * `setu help`, and the non-`ports` `workspace` arm, which prints the
   * `ports` usage).
   */
  readonly documented: readonly string[];
  /**
   * The positional contract, refused beside the flag check. Absent where the
   * command already refuses every over-arity input itself: `add` names its
   * own extras (X18-1), and the non-`ports` `workspace` arm refuses every
   * subcommand but `ports`. A plugin command's positionals are its handler's
   * input and are never checked here.
   */
  readonly positionals?: ICommandPositionals;
}

function spec(
  label: string,
  documented: readonly string[],
  recognizedRefusals: readonly string[] = [],
  positionals?: ICommandPositionals,
): ICommandFlagSpec {
  return {
    label,
    allowed: [...GLOBAL_FLAGS, ...documented, ...recognizedRefusals],
    documented,
    // Omitted rather than passed as `undefined`: exactOptionalPropertyTypes.
    ...(positionals === undefined ? {} : { positionals }),
  };
}

/** `setu new`: everything `--help` documents, plus the M65 named refusals. */
const NEW: ICommandFlagSpec = spec(
  'new',
  [
    'template',
    'runtime',
    'env-file',
    'workspace',
    'port',
    'transport',
    'transport-url',
    'broker',
    'queue',
    'yes',
    'y',
    'dir',
    'dry-run',
  ],
  // Read ONLY to be refused with their own guidance: `--di` points at
  // `--template class-based` (M65), `--depends-on` points at `generate app`.
  ['di', 'depends-on'],
  // `new <project-name>`: one name, exactly. Extras used to be dropped.
  { fixed: 1, taken: 1, noun: 'one project name' },
);

/** `setu generate` for a schematic: the schematic word plus one name. */
const GENERATE: ICommandFlagSpec = spec(
  'generate',
  ['dir', 'dry-run', 'runtime'],
  [],
  { fixed: 2, taken: 1, noun: 'one name' },
);

/** `setu generate custom <schematic-name> <name>`: two names after the verb. */
const GENERATE_CUSTOM: ICommandFlagSpec = spec(
  'generate custom',
  ['dir', 'dry-run', 'runtime'],
  [],
  { fixed: 2, taken: 2, noun: 'two names: the custom schematic and the artifact name' },
);

/** `setu generate app`: the workspace-member flags, plus the named refusals. */
const GENERATE_APP: ICommandFlagSpec = spec(
  'generate app',
  ['template', 'port', 'env-file', 'depends-on', 'dir', 'dry-run'],
  // Read ONLY to be refused with their own guidance: the four transport flags
  // name the workspace-wide alternative, `--runtime` names the workspace's own
  // toolchain when it disagrees, and `--di` goes through `resolveTemplateChoice`.
  ['transport', 'transport-url', 'broker', 'queue', 'runtime', 'di'],
  { fixed: 2, taken: 1, noun: 'one member name' },
);

/** `setu generate library`. */
const GENERATE_LIBRARY: ICommandFlagSpec = spec(
  'generate library',
  ['scope', 'dir', 'dry-run'],
  [],
  { fixed: 2, taken: 1, noun: 'one library name' },
);

/**
 * `setu add <plugin>` carries no positional contract here ON PURPOSE: the
 * command refuses its own extras with X18-1's wording (`setu add takes one
 * package; got 3. Run it once per package.`), and this check must not preempt
 * that message with a second way of saying the same thing.
 */
const ADD: ICommandFlagSpec = spec('add', ['dir', 'dry-run']);

/** `setu adopt`: takes no positionals at all — `--name` and `--port` are flags. */
const ADOPT: ICommandFlagSpec = spec(
  'adopt',
  ['name', 'port', 'dir', 'dry-run'],
  [],
  { fixed: 1, taken: 0, noun: 'no arguments' },
);

/** `setu workspace ports --reallocate`: `ports` is the last word it reads. */
const WORKSPACE_PORTS: ICommandFlagSpec = spec(
  'workspace ports',
  [
    'reallocate',
    'dir',
    'dry-run',
  ],
  [],
  { fixed: 2, taken: 0, noun: 'no arguments beyond ports' },
);

/**
 * `setu workspace` with a subcommand other than `ports`: the command itself
 * refuses every subcommand but `ports` with its usage line, so there is no
 * silent drop for this check to close and no positional contract here.
 * `--reallocate` is kept recognized-but-refused so that `workspace
 * --reallocate` (subcommand omitted) reaches that teaching usage line — which
 * names the fix — instead of a generic "Unknown option"; anything genuinely
 * foreign stays strictly refused.
 */
const WORKSPACE: ICommandFlagSpec = spec('workspace', [], ['reallocate']);

/**
 * `setu commands` accepts the documented global help flags. `runCli` prints
 * top-level help before this command can check for a project config module.
 */
const COMMANDS: ICommandFlagSpec = {
  label: 'commands',
  allowed: [...GLOBAL_FLAGS, 'dir', 'config'],
  documented: [],
  positionals: { fixed: 1, taken: 0, noun: 'no arguments' },
};

/** `setu help` prints the top-level usage; the help flags are its only input. */
const HELP: ICommandFlagSpec = spec('help', [], [], {
  fixed: 1,
  taken: 0,
  noun: 'no arguments',
});

/**
 * Resolves the inventory entry for a built-in command, subcommand-aware:
 * `generate app`/`generate library`/`generate custom` carry their own
 * positional contracts, and `workspace ports` likewise.
 *
 * @param command - The first positional (`new`, `generate`, …)
 * @param subcommand - The second positional, when present
 * @returns The entry, or `undefined` for anything else — those are the
 * plugin-command arm, checked in `dispatchPluginCommand` by
 * {@linkcode firstUnknownFlag} against {@linkcode PLUGIN_COMMAND_FLAGS},
 * after the config module is known to exist and before the application boots
 */
export function commandFlagsFor(
  command: string,
  subcommand: string | undefined,
): ICommandFlagSpec | undefined {
  switch (command) {
    case 'new':
    case 'n':
      return NEW;
    case 'generate':
    case 'g':
      if (subcommand === 'app') return GENERATE_APP;
      if (subcommand === 'library') return GENERATE_LIBRARY;
      if (subcommand === 'custom') return GENERATE_CUSTOM;
      return GENERATE;
    case 'add':
      return ADD;
    case 'adopt':
      return ADOPT;
    case 'workspace':
      return subcommand === 'ports' ? WORKSPACE_PORTS : WORKSPACE;
    case 'commands':
      return COMMANDS;
    case 'help':
      return HELP;
    default:
      return undefined;
  }
}

/**
 * The inventory the help↔inventory gate asserts against, keyed by label.
 *
 * Consumer: `test/unit/flags.test.ts`, which renders each command's `--help`
 * through `runCli` and asserts the parsed flag names equal this set exactly —
 * every flag the help text presents is in the allowlist, and every documented
 * allowlist flag appears in the help text — so the two cannot drift.
 */
export const DOCUMENTED_FLAGS: ReadonlyMap<string, readonly string[]> = new Map([
  [NEW.label, NEW.documented],
  [GENERATE.label, GENERATE.documented],
  [GENERATE_APP.label, GENERATE_APP.documented],
  [GENERATE_LIBRARY.label, GENERATE_LIBRARY.documented],
  [ADD.label, ADD.documented],
  [ADOPT.label, ADOPT.documented],
  [WORKSPACE_PORTS.label, WORKSPACE_PORTS.documented],
]);

/**
 * The first flag name outside `allowed`, in the order the user supplied them,
 * or `undefined` when every flag is known.
 *
 * Flag KEYS are checked, never raw tokens: `parseArgs` records `-k=value` under
 * the key `k`, and everything after `--` becomes positional, so neither form
 * can be misreported.
 *
 * @param flags - The parsed flag record
 * @param allowed - The inventory for this invocation
 * @returns The first unknown name, or `undefined`
 */
export function firstUnknownFlag(
  flags: Readonly<Record<string, string | boolean | readonly string[]>>,
  allowed: readonly string[],
): string | undefined {
  const known = new Set(allowed);
  for (const name of Object.keys(flags)) {
    if (!known.has(name)) return name;
  }
  return undefined;
}

/**
 * How far a typed flag may sit from its nearest known name and still be
 * suggested.
 *
 * Two is the smallest threshold that catches the case that motivated this
 * module (`templat` → `template` is distance 2) while staying well below the
 * distance at which a suggestion stops meaning anything (`totally-bogus-flag`
 * matches nothing within it, and neither does a two-letter fragment like `xyz`,
 * whose nearest real name is 3 away).
 */
const SUGGESTION_MAX_DISTANCE = 2;

/**
 * Plain two-row Levenshtein distance — no dependency.
 *
 * @param a - The left string
 * @param b - The right string
 * @returns The minimum edit distance
 */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  let previous: number[] = [];
  for (let j = 0; j <= b.length; j++) previous[j] = j;
  for (let i = 1; i <= a.length; i++) {
    const current: number[] = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitute = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, substitute);
    }
    previous = current;
  }
  return previous[b.length];
}

/**
 * The nearest allowed name within {@linkcode SUGGESTION_MAX_DISTANCE}, or
 * `undefined` when nothing is close enough.
 *
 * Comparison runs over the whole token AND each `-`-separated segment of the
 * input, so `base-port` reaches `port` (its last segment is an exact match)
 * where the whole-token distance of 5 would not. Candidates are the LONG names
 * only — a single-letter alias is never a useful suggestion — walked in sorted
 * order, so ties resolve deterministically.
 *
 * @param input - The flag name the user typed, without dashes
 * @param candidates - The allowed flag names for this invocation
 * @returns The suggestion, or `undefined` for no suggestion
 */
export function suggestFlag(input: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = SUGGESTION_MAX_DISTANCE + 1;
  for (const candidate of [...candidates].sort()) {
    if (candidate.length < 2) continue;
    let distance = levenshtein(input, candidate);
    for (const segment of input.split('-')) {
      distance = Math.min(distance, levenshtein(segment, candidate));
    }
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return bestDistance <= SUGGESTION_MAX_DISTANCE ? best : undefined;
}

/**
 * Builds the refusal for one unknown flag, naming the command and — when
 * something is close enough — the flag the user probably meant.
 *
 * @param commandLabel - The command as the user's invocation names it
 * @param flag - The unknown flag name, without dashes
 * @param allowed - The inventory for this invocation
 * @returns The message for the error sink
 */
export function unknownOptionMessage(
  commandLabel: string,
  flag: string,
  allowed: readonly string[],
): string {
  const suggestion = suggestFlag(flag, allowed);
  return `Unknown option \`--${flag}\` for \`${PROGRAM_NAME} ${commandLabel}\`.` +
    (suggestion === undefined ? '' : ` Did you mean \`--${suggestion}\`?`);
}

/**
 * The dispatcher's strict check for a built-in command: refuses the first
 * unknown flag with exit 2 and reports it on the error sink, before any command
 * body runs, so nothing is written or created.
 *
 * @param command - The first positional
 * @param subcommand - The second positional, when present
 * @param flags - The parsed flag record
 * @param error - The error sink
 * @returns {@linkcode EXIT_USAGE} when refused, `undefined` to continue —
 * including for the plugin-command arm, which is checked at dispatch
 */
export function builtInFlagRefusal(
  command: string,
  subcommand: string | undefined,
  flags: Readonly<Record<string, string | boolean | readonly string[]>>,
  error: (message: string) => void,
): number | undefined {
  const entry = commandFlagsFor(command, subcommand);
  if (entry === undefined) return undefined;
  const unknown = firstUnknownFlag(flags, entry.allowed);
  if (unknown === undefined) return undefined;
  error(unknownOptionMessage(entry.label, unknown, entry.allowed));
  return EXIT_USAGE;
}

/**
 * Builds the over-arity refusal, naming the command, what it takes, and how
 * many arguments were supplied — the wording pattern of `add`'s own X18-1
 * refusal, which stays the command's own because this check deliberately
 * carries no contract for `add`.
 *
 * @param label - The command as the user's invocation names it
 * @param noun - What the command takes, phrased with its count
 * @param got - The arguments supplied beyond the command's fixed words
 * @returns The message for the error sink
 */
export function extraPositionalsMessage(
  label: string,
  noun: string,
  got: number,
): string {
  return `${PROGRAM_NAME} ${label} takes ${noun}; got ${got}.`;
}

/**
 * The dispatcher's strict check for a built-in command's positional arity:
 * refuses an invocation supplying more arguments than the command consumes —
 * `new app extra junk` used to scaffold `app` and report success — with exit
 * 2 and the message on the error sink, before any command body runs, so
 * nothing is written or created.
 *
 * Everything after `--` is a positional ([`parseArgs`](./args.ts)), so
 * terminator-hidden tokens refuse here too; that is exactly how a stray
 * flag-shaped token reaches a command as a positional.
 *
 * @param command - The first positional
 * @param positionals - The full parsed positional array, verb included
 * @param error - The error sink
 * @returns {@linkcode EXIT_USAGE} when refused, `undefined` to continue —
 * including for entries with no positional contract (`add`, the non-`ports`
 * `workspace` arm) and the plugin-command arm, whose positionals are the
 * handler's input
 */
export function builtInPositionalRefusal(
  command: string,
  positionals: readonly string[],
  error: (message: string) => void,
): number | undefined {
  const entry = commandFlagsFor(command, positionals[1]);
  if (entry?.positionals === undefined) return undefined;
  const { fixed, taken, noun } = entry.positionals;
  const got = positionals.length - fixed;
  if (got <= taken) return undefined;
  error(extraPositionalsMessage(entry.label, noun, got));
  return EXIT_USAGE;
}
