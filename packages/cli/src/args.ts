/**
 * Zero-dependency argument parser for the setu CLI.
 *
 * Handles positionals, boolean flags, `--key=value`, `--key value` for the
 * declared value-taking flags, and the `--` terminator.
 *
 * @module
 */

import { VALUE_FLAGS } from './constants.ts';

/**
 * Parsed command-line arguments.
 */
export interface ParsedArgs {
  /** The positional arguments, in order (command, subcommand, name, …). */
  readonly positionals: readonly string[];
  /** Flag values: `true` for boolean flags, the string for valued flags. */
  readonly flags: Readonly<Record<string, string | boolean>>;
}

/**
 * Parse a command-line argument array into positionals and flags.
 *
 * Supports:
 * - Positional arguments anywhere, and everything after `--`
 * - Boolean flags (`--dry-run`, `-h`)
 * - `--key=value` (and `-k=value`)
 * - `--key value` for the flags named in {@linkcode VALUE_FLAGS}
 *
 * A valued flag at the end of argv with no following token, or followed by
 * another flag, is recorded as the boolean `true` — callers type-check the
 * value before using it.
 *
 * @param argv - The argument array (e.g. `Deno.args`)
 * @param valueFlags - Flags whose value is the next token; defaults to {@linkcode VALUE_FLAGS}
 * @returns The parsed positionals and flags
 */
export function parseArgs(
  argv: readonly string[],
  valueFlags: ReadonlySet<string> = VALUE_FLAGS,
): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--') {
      // Everything after the terminator is positional, flag-looking or not.
      positionals.push(...argv.slice(i + 1));
      break;
    }

    if (!arg.startsWith('-') || arg === '-') {
      positionals.push(arg);
      continue;
    }

    const body = arg.startsWith('--') ? arg.slice(2) : arg.slice(1);

    if (body.includes('=')) {
      const eq = body.indexOf('=');
      const key = body.slice(0, eq);
      const value = body.slice(eq + 1);
      flags[key] = value === '' ? true : value;
      continue;
    }

    // `--dir /tmp`: consume the next token when this flag takes a value and
    // the next token is not itself a flag.
    const next = argv[i + 1];
    if (valueFlags.has(body) && next !== undefined && next !== '--' && !next.startsWith('-')) {
      flags[body] = next;
      i++;
      continue;
    }

    flags[body] = true;
  }

  return {
    positionals: Object.freeze(positionals) as readonly string[],
    flags: Object.freeze(flags),
  };
}

/**
 * Reads a flag that must carry a string value.
 *
 * @param flags - The parsed flag record
 * @param name - The flag name
 * @returns The string value, or undefined when absent or supplied as a boolean
 */
export function stringFlag(
  flags: Readonly<Record<string, string | boolean>>,
  name: string,
): string | undefined {
  const value = flags[name];
  return typeof value === 'string' ? value : undefined;
}
