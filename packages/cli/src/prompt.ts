/**
 * The prompt seam — how `setu new` asks a question when it may.
 *
 * Everything DECIDABLE lives here, because this file is measured by the
 * coverage bar and `src/main.ts` never is: no test imports `main.ts`, so Deno
 * never loads it and it never appears in the table. Hence the three effects a
 * terminal prompter needs — "may I ask at all", "read one line", "print" — are
 * parameters, and the branching around them is unit-tested against fakes.
 *
 * Three facts were measured on deno 2.9.5 rather than read (plan §1.1), and
 * each shaped this design:
 * - `prompt()` returns `null` in ~1 ms when stdin is not a terminal, so the
 *   built-in cannot hang a non-interactive run;
 * - bare Enter returns `''`, which means "accept the default" — distinct from
 *   `null`, which means "cannot ask";
 * - the second `prompt()` argument PRE-FILLS an editable buffer, not a
 *   fallback, so it is deliberately unused: the default is rendered inside the
 *   question text instead.
 *
 * @module
 */

/** One selectable answer to a scaffold question. */
export interface PromptChoice {
  /** The value written into the flag record when chosen. */
  readonly value: string;
  /** One line describing what the choice does, shown above the question. */
  readonly label: string;
}

/**
 * Asks one question and reports the chosen value.
 *
 * @param question - The question text; the default is rendered inside it
 * @param choices - The acceptable answers, first being the default
 * @returns The chosen value, or undefined when no answer could be taken
 */
export interface Prompter {
  select(question: string, choices: readonly PromptChoice[]): Promise<string | undefined>;
}

/**
 * Builds the terminal implementation of {@linkcode Prompter} over Deno's
 * built-in `prompt()`.
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
 * @param promptFn - Reads one line, returning null when it cannot
 * @param log - Prints the choice list and retry hints
 * @returns The prompter
 */
export function createTerminalPrompter(
  isTerminal: () => boolean,
  promptFn: (message: string) => string | null,
  log: (message: string) => void,
): Prompter {
  return {
    select(question: string, choices: readonly PromptChoice[]): Promise<string | undefined> {
      // The SECOND line of defense against blocking a non-interactive run: the
      // primary guarantee is that `ask` is optional and gates do not pass it,
      // and the third is `prompt()`'s own measured null return here.
      if (!isTerminal() || choices.length === 0) return Promise.resolve(undefined);

      const fallback = choices[0];
      const menu = choices.map((choice) => `  ${choice.value} — ${choice.label}`).join('\n');

      for (;;) {
        log(menu);
        const answer = promptFn(`${question} [${fallback.value}] `);
        // Both "stdin was never a terminal" and "the user pressed Ctrl-D"
        // arrive here; both mean stop asking, never "take the default".
        if (answer === null) return Promise.resolve(undefined);
        if (answer === '') return Promise.resolve(fallback.value);
        const match = choices.find((choice) => choice.value === answer);
        if (match !== undefined) return Promise.resolve(match.value);
        log(
          `"${answer}" is not one of: ${choices.map((choice) => choice.value).join(', ')}.`,
        );
      }
    },
  };
}
