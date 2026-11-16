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
import type { KeyReader, PickerKey } from './terminal-keys.ts';

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
 * @param interrupt - Aborts a pending question
 * @param picker - When the terminal can read single keys: the arrow-key list
 *   replaces the typed answer, drawn through `write` (raw, so it can move the
 *   cursor), with the highlighted option coloured when `color` is set
 * @returns The prompter
 */
export function createTerminalPrompter(
  isTerminal: () => boolean,
  promptFn: (message: string, signal?: AbortSignal) => Promise<string | null>,
  log: (message: string) => void,
  interrupt?: AbortSignal,
  picker?: PickerTerminal,
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

      if (picker !== undefined) return pick(question, choices, picker, interrupted, interrupt);

      const fallback = choices[0];
      const menu = choices
        .map((choice) =>
          choice.label === choice.value
            ? `  ${choice.value}`
            : `  ${choice.value} — ${choice.label}`,
        )
        .join('\n');

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

/** The colour level the arrow-key list draws with. */
export type PickerColor = 'truecolor' | 'ansi' | 'none';

/** The terminal surface the arrow-key list draws on. */
export interface PickerTerminal {
  /** Reads one key in raw mode. */
  readonly keys: KeyReader;
  /** Writes raw text, escape sequences included. */
  readonly write: (text: string) => void;
  /**
   * How to colour the highlighted option: a 24-bit gradient, one ANSI colour
   * (bold cyan) on a 16/256-colour terminal, or none (`NO_COLOR`, no colours).
   */
  readonly color: PickerColor;
}

/** One step of the arrow-key list: where the highlight moves, and whether that settles it. */
export interface PickerStep {
  readonly index: number;
  readonly done?: 'select' | 'cancel';
}

/**
 * The highlight after one key: arrows (and `j`/`k`) move and wrap, Home and End
 * jump, a digit jumps to that option, Enter selects and Escape cancels.
 *
 * @param index - The highlighted option
 * @param key - The key pressed
 * @param count - How many options there are
 * @returns The new highlight, and `done` when the key settles the question
 */
export function pickerStep(index: number, key: PickerKey, count: number): PickerStep {
  switch (key.kind) {
    case 'up':
      return { index: (index - 1 + count) % count };
    case 'down':
      return { index: (index + 1) % count };
    case 'home':
      return { index: 0 };
    case 'end':
      return { index: count - 1 };
    case 'digit':
      return { index: key.value <= count ? key.value - 1 : index };
    case 'enter':
      return { index, done: 'select' };
    case 'escape':
      return { index, done: 'cancel' };
    default:
      return { index };
  }
}

/** The highlight gradient's ends: cyan to violet. */
const GRADIENT_FROM = [34, 211, 238] as const;
const GRADIENT_TO = [168, 85, 247] as const;

/**
 * Colours text with a left-to-right truecolor gradient, one step per character.
 *
 * @param text - Plain text, already escaped
 * @returns The text wrapped in 24-bit colour sequences, bold, reset at the end
 */
export function gradient(text: string): string {
  const chars = [...text];
  const last = Math.max(chars.length - 1, 1);
  const coloured = chars.map((char, i) => {
    const [r, g, b] = GRADIENT_FROM.map((from, channel) =>
      Math.round(from + ((GRADIENT_TO[channel]! - from) * i) / last),
    );
    return `\x1b[38;2;${r};${g};${b}m${char}`;
  });
  return `\x1b[1m${coloured.join('')}\x1b[0m`;
}

/**
 * The highlighted text at a colour level.
 *
 * @param text - Plain text, already escaped
 * @param level - The terminal's colour level
 * @returns The text, coloured for that level
 */
export function highlight(text: string, level: PickerColor): string {
  if (level === 'truecolor') return gradient(text);
  return level === 'ansi' ? `\x1b[1;36m${text}\x1b[0m` : text;
}

/**
 * The arrow-key list's lines for one frame.
 *
 * @param question - The question text
 * @param choices - The options, the default first
 * @param index - The highlighted option
 * @param level - How to colour the highlight
 * @returns One line for the question and one per option
 */
export function renderPicker(
  question: string,
  choices: readonly PromptChoice[],
  index: number,
  level: PickerColor,
): readonly string[] {
  const color = level !== 'none';
  const hint = '(↑/↓ or a number to move, Enter to choose)';
  return [
    `${color ? '\x1b[36m?\x1b[0m' : '?'} ${escapeTerminalControls(question)} ${color ? `\x1b[2m${hint}\x1b[0m` : hint}`,
    ...choices.map((choice, i) => {
      const value = escapeTerminalControls(choice.value);
      const label =
        choice.label === choice.value ? '' : ` — ${escapeTerminalControls(choice.label)}`;
      const number = `${i + 1}.`;
      if (i !== index)
        return `   ${number} ${value}${color && label !== '' ? `\x1b[2m${label}\x1b[0m` : label}`;
      return ` ${highlight(`❯ ${number} ${value}`, level)}${label}`;
    }),
  ];
}

/** Runs one arrow-key question, redrawing the list in place after each key. */
async function pick(
  question: string,
  choices: readonly PromptChoice[],
  terminal: PickerTerminal,
  interrupted: () => boolean,
  interrupt: AbortSignal | undefined,
): Promise<PromptSelection> {
  let index = 0;
  let drawn = 0;
  // Up to the first line drawn, then clear to the end of the screen.
  const rewind = (): string => (drawn === 0 ? '' : `\x1b[${drawn}A\r\x1b[0J`);
  const draw = (): void => {
    const lines = renderPicker(question, choices, index, terminal.color);
    terminal.write(`${rewind()}${lines.join('\n')}\n`);
    drawn = lines.length;
  };
  // A settled question collapses to one line, so the scrollback keeps the answer
  // (or the cancellation) rather than a stale list.
  const cancelled = (): PromptSelection => {
    terminal.write(
      `${rewind()}${terminal.color === 'none' ? '✖' : '\x1b[31m✖\x1b[0m'} ${escapeTerminalControls(question)}\n`,
    );
    drawn = 0;
    return { kind: 'cancelled' };
  };
  terminal.write('\x1b[?25l');
  try {
    draw();
    for (;;) {
      if (interrupted()) return cancelled();
      const key = await terminal.keys.read(interrupt);
      if (key === null || interrupted()) return cancelled();
      const step = pickerStep(index, key, choices.length);
      if (step.done === 'cancel') return cancelled();
      index = step.index;
      if (step.done === 'select') {
        const value = choices[index]!.value;
        const shown = escapeTerminalControls(value);
        terminal.write(
          `${rewind()}${terminal.color === 'none' ? '✔' : '\x1b[32m✔\x1b[0m'} ${escapeTerminalControls(question)} · ${highlight(shown, terminal.color)}\n`,
        );
        drawn = 0;
        return { kind: 'answer', value };
      }
      draw();
    }
  } finally {
    terminal.write('\x1b[?25h');
  }
}
