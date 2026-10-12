/**
 * Reads one answer from a terminal on Node — the line reader behind the
 * interactive prompter.
 *
 * Three behaviours make it safe to wait on, and each is a reason this is not a
 * bare `question()`:
 * - a terminal Ctrl+C reaches `readline` as a keystroke in raw mode, never as a
 *   process signal, so the interface's own `'SIGINT'` event is translated into
 *   the run's interrupt — without a listener readline only pauses the stream;
 * - the run's interrupt signal cancels a pending question, so an interrupt
 *   delivered from outside (or by the translation above) never waits for Enter;
 * - the interface is closed whatever the outcome, because an open one keeps the
 *   process alive after `exitCode` is set.
 *
 * Every non-answer resolves `null` — EOF, an interrupt, a stream error — which
 * the prompter reads as "stop asking".
 *
 * @module
 */

import { createInterface } from 'node:readline/promises';
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

/**
 * Builds the asynchronous line reader the terminal prompter calls once per
 * question.
 *
 * @param options - The streams and the interrupt hook
 * @returns A reader resolving the line typed, or `null` when there is none
 */
export function createLineReader(
  options: LineReaderOptions,
): (message: string, signal?: AbortSignal) => Promise<string | null> {
  return async (message, signal) => {
    if (signal?.aborted === true) return null;
    const rl = createInterface({
      input: options.input,
      output: options.output,
      terminal: options.terminal,
    });
    // A question that ends without an answer — EOF, Ctrl+C, or the signal —
    // resolves this instead, so `question()`'s pending promise never decides.
    let settleEarly: (value: null) => void = () => {};
    const early = new Promise<null>((resolve) => {
      settleEarly = resolve;
    });
    const onClose = (): void => settleEarly(null);
    const onSigint = (): void => {
      options.onInterrupt();
      settleEarly(null);
    };
    const onAbort = (): void => settleEarly(null);
    rl.once('close', onClose);
    rl.once('SIGINT', onSigint);
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      // The rejection `question()` raises when the interface closes under it is
      // swallowed here and reported through `early` instead.
      const answer = rl.question(message).catch(() => null);
      return await Promise.race([answer, early]);
    } finally {
      signal?.removeEventListener('abort', onAbort);
      rl.off('close', onClose);
      rl.off('SIGINT', onSigint);
      rl.close();
    }
  };
}
