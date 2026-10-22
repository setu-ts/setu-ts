/**
 * The prompt seam — how `setu new` asks a question when it may.
 *
 * Everything DECIDABLE lives here, so the three effects a terminal prompter
 * needs — "may I ask at all", "read one line", "print" — are parameters, and
 * the branching around them is unit-tested against fakes.
 *
 * The read is asynchronous and abortable. A blocking read cannot dispatch the
 * SIGINT handler `src/main.ts` registers, so a question pending when the user
 * pressed Ctrl+C would wait for Enter; the line reader instead receives the
 * run's interrupt signal and resolves `null` when it fires. Two answers keep
 * their meaning: `null` means "cannot or will not answer" and `''` (bare
 * Enter) means "accept the default", which is rendered inside the question
 * text rather than pre-filled.
 *
 * @module
 */

import { escapeName, escapeTerminalControls } from './utils/names.ts';

/** One selectable answer to a scaffold question. */
export interface PromptChoice {
  /** The value written into the flag record when chosen. */
  readonly value: string;
  /** One line describing what the choice does, shown above the question. */
  readonly label: string;
}

/**
 * The outcome of asking one interactive CLI question.
 *
 * @since 0.9.0
 */
export type PromptSelection =
  | { readonly kind: 'answer'; readonly value: string }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'cancelled' };

/** Asks the scaffold questions `setu new` accepts as flags. */
export interface Prompter {
  /**
   * Asks one question and reports the chosen value.
   *
   * @param question - The question text; the default is rendered inside it
   * @param choices - The acceptable answers, first being the default
   * @returns The answer, cancellation, or inability to ask
   *
   * In 0.9.0 the return changed to {@linkcode PromptSelection}; earlier versions returned a string
   * or `undefined`.
   */
  select(question: string, choices: readonly PromptChoice[]): Promise<PromptSelection>;
}

/**
 * Builds the terminal implementation of {@linkcode Prompter} over an
 * asynchronous line reader.
 *
 * NOT barrel-exported on purpose: its only consumer is `src/main.ts`, which
 * imports it directly, and a second export with no reader is dead surface. A
 * programmatic consumer that wants prompting supplies its own `Prompter`.
 *
 * All three failure modes fail closed: a non-terminal never reaches
 * {@linkcode promptFn}; an EOF (`null`) answer ends the question as unanswered;
 * and mid-session EOF after an unrecognized answer does the same rather than
 * looping forever.
 *
 * @param isTerminal - Whether stdin is an interactive terminal right now
 * @param promptFn - Reads one line, resolving null when it cannot or when
 *   the signal it is handed aborts first
 * @param log - Prints the choice list and retry hints; every line is passed
 *   through `escapeTerminalControls` first, because this sink is not the one
 *   `runCli` wraps. That escape keeps the line feed, and an answer CAN carry
 *   one — a terminal line reader keeps a newline inside a bracketed paste and
 *   inserts one on Ctrl-V Ctrl-J
 *   — so the echoed answer is also escaped where it is quoted
 * @returns The prompter
 */
export function createTerminalPrompter(
  isTerminal: () => boolean,
  promptFn: (message: string, signal?: AbortSignal) => Promise<string | null>,
  log: (message: string) => void,
  interrupt?: AbortSignal,
): Prompter {
  const print = (message: string): void => log(escapeTerminalControls(message));
  // A function rather than an inline read: the signal can fire WHILE
  // `promptFn` awaits, which property narrowing across the call cannot see.
  const interrupted = (): boolean => interrupt?.aborted === true;
  return {
    async select(question: string, choices: readonly PromptChoice[]): Promise<PromptSelection> {
      // The SECOND line of defense against blocking a non-interactive run: the
      // primary guarantee is that `ask` is optional and gates do not pass it,
      // and the third is the reader resolving null when it cannot read.
      if (!isTerminal() || choices.length === 0) {
        return { kind: 'unavailable' };
      }

      const fallback = choices[0];
      const menu = choices.map((choice) => `  ${choice.value} — ${choice.label}`).join('\n');

      for (;;) {
        // Checked BEFORE each prompt as well as after: an interrupt that has
        // already fired must not open a read it would then wait on.
        if (interrupted()) return { kind: 'cancelled' };
        print(menu);
        // Again after printing: the write itself can be where the interrupt
        // lands, and the read below would then block on input nobody sends.
        if (interrupted()) return { kind: 'cancelled' };
        const answer = await promptFn(`${question} [${fallback.value}] `, interrupt);
        // Both "stdin was never a terminal" and "the user pressed Ctrl-D"
        // arrive here; both mean stop asking, never "take the default".
        if (answer === null || interrupted()) {
          return { kind: 'cancelled' };
        }
        if (answer === '') return { kind: 'answer', value: fallback.value };
        const match = choices.find((choice) => choice.value === answer);
        if (match !== undefined) return { kind: 'answer', value: match.value };
        print(
          `"${escapeName(answer)}" is not one of: ${choices
            .map((choice) => choice.value)
            .join(', ')}.`,
        );
      }
    },
  };
}
