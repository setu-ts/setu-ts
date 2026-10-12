/**
 * Reads answers from a terminal on Node — the line reader behind the
 * interactive prompter.
 *
 * One `readline` interface serves the whole run, opened on the first question
 * and closed by {@linkcode LineReader.close}. Lines that arrive while no
 * question is pending — an answer typed or pasted ahead — are queued for the
 * next one rather than lost with a per-question interface. Four behaviours make
 * it safe to wait on:
 * - a terminal Ctrl+C reaches `readline` as a keystroke in raw mode, never as a
 *   process signal, so the interface's own `'SIGINT'` event is translated into
 *   the run's interrupt — without a listener readline only pauses the stream;
 * - the run's interrupt signal cancels a pending question, so an interrupt
 *   delivered from outside (or by the translation above) never waits for Enter;
 * - an input stream error ends the reader instead of escaping as an uncaught
 *   `'error'` and leaving the question pending;
 * - `close()` releases the interface, because an open one keeps the process
 *   alive after the exit code is set.
 *
 * Every non-answer resolves `null` — EOF, an interrupt, a stream error — which
 * the prompter reads as "stop asking".
 *
 * @module
 */

import { createInterface, type Interface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

/** The streams and hooks one {@linkcode createLineReader} reads through. */
export interface LineReaderOptions {
  /** Where answers are read from. */
  readonly input: Readable;
  /** Where the question is written. */
  readonly output: Writable;
  /** Whether the input is an interactive terminal (raw mode, Ctrl+C as a key). */
  readonly terminal: boolean;
  /** Called when the user presses Ctrl+C at the question. */
  readonly onInterrupt: () => void;
}

/** A line reader shared by every question in one run. */
export interface LineReader {
  /** Asks one question, resolving the line or `null` when there is none. */
  read(message: string, signal?: AbortSignal): Promise<string | null>;
  /** Releases the interface; later reads resolve `null`. */
  close(): void;
}

/**
 * Builds the line reader the terminal prompter calls once per question.
 *
 * @param options - The streams and the interrupt hook
 * @returns The reader
 */
export function createLineReader(options: LineReaderOptions): LineReader {
  let rl: Interface | undefined;
  let ended = false;
  const queued: string[] = [];
  // The one question that may be pending; `settle` resolves it.
  let pending: ((value: string | null) => void) | undefined;

  const settle = (value: string | null): void => {
    const resolve = pending;
    pending = undefined;
    resolve?.(value);
  };
  const end = (): void => {
    ended = true;
    settle(null);
  };

  const open = (): Interface => {
    if (rl !== undefined) return rl;
    rl = createInterface({ input: options.input, output: options.output, terminal: options.terminal });
    rl.on('line', (line) => {
      if (pending === undefined) queued.push(line);
      else settle(line);
    });
    rl.on('close', end);
    rl.on('error', end);
    rl.on('SIGINT', () => {
      options.onInterrupt();
      settle(null);
    });
    return rl;
  };

  return {
    read(message, signal) {
      if (ended || signal?.aborted === true) return Promise.resolve(null);
      const reader = open();
      options.output.write(message);
      const next = queued.shift();
      if (next !== undefined) return Promise.resolve(next);
      return new Promise((resolve) => {
        const onAbort = (): void => settle(null);
        signal?.addEventListener('abort', onAbort, { once: true });
        pending = (value) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(value);
        };
        reader.resume();
      });
    },
    close() {
      const current = rl;
      rl = undefined;
      ended = true;
      settle(null);
      current?.close();
    },
  };
}
