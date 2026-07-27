/**
 * Zero-dependency argument parser for the honoe CLI.
 * Handles flags, positionals, -- terminator, and key=value pairs.
 *
 * @module
 */

/**
 * Parsed command-line arguments.
 */
export interface ParsedArgs {
  /** The parsed positional arguments (command, subcommand, name, etc.). */
  readonly positionals: readonly string[];
  /** The parsed flag/key=value options. */
  readonly flags: Readonly<Record<string, string | boolean>>;
  /** Whether a -- terminator was encountered. */
  readonly endOfOptions: boolean;
}

/**
 * Parse a command-line argument array into positionals and flags.
 *
 * Supports:
 * - Positional arguments before flags or after `--`
 * - Flags like `--flag`, `-f`, `--key=value`, `key=value`
 * - Boolean flags without values
 * - Unknown flags are stored as-is
 *
 * @param argv - The array of command-line arguments (excluding argv[0] and argv[1])
 * @returns A ParsedArgs object containing positionals and flags
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  let endOfOptions = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--') {
      endOfOptions = true;
      // Everything after -- is positional
      positionals.push(...argv.slice(i + 1));
      break;
    } else if (endOfOptions) {
      // All remaining args are positionals
      positionals.push(arg);
    } else if (arg.startsWith('-')) {
      // This is a flag
      if (arg.includes('=')) {
        // Key=value format in one token (--flag=value or -flag=value)
        const flagStr = arg.startsWith('--') ? arg.slice(2) : arg.slice(1);
        const [key, ...valueParts] = flagStr.split('=');
        const value = valueParts.join('=');
        flags[key] = value === '' ? true : value;
      } else if (arg.startsWith('--')) {
        // Long flag (--flag or --flag=value handled above)
        const flagName = arg.slice(2);
        // Long flags are boolean unless they have a value in --key=value format (handled above)
        flags[flagName] = true;
      } else {
        // Short flag (-f)
        const flagName = arg.slice(1);
        // Short flags are boolean by default; use -f=value to assign a value
        flags[flagName] = true;
      }
    } else {
      // Positional argument
      positionals.push(arg);
    }
  }

  return {
    positionals: Object.freeze(positionals) as readonly string[],
    flags: Object.freeze(flags),
    endOfOptions,
  };
}
