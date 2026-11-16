/**
 * Single-key input for the arrow-key option picker.
 *
 * Built on Node's own `readline.emitKeypressEvents`, so no dependency: the
 * terminal is put in raw mode only while one key is awaited, and restored
 * before the promise settles, so a key read can never leave the user's shell
 * without echo. Ctrl+C is delivered through `onInterrupt`, the same path a
 * process signal takes (see `nodeProcess` in `main.ts`). Keys that arrive in
 * one chunk (a paste, or input typed ahead) are queued for the next reads
 * rather than dropped. The listener is held only while a read is waiting and
 * the chunk that settled it is delivered, so keys typed at a later text
 * question never reach the picker; `beforeRead` lets the text reader step
 * aside before a picker read, so the two never own the input at once.
 *
 * @module
 */
import process from 'node:process';
import { emitKeypressEvents } from 'node:readline';
import type { PickerColor, PickerTerminal } from './prompt.ts';

/** The keys the picker acts on; anything else arrives as `'other'`. */
export type PickerKey =
  | { readonly kind: 'up' }
  | { readonly kind: 'down' }
  | { readonly kind: 'home' }
  | { readonly kind: 'end' }
  | { readonly kind: 'enter' }
  | { readonly kind: 'escape' }
  | { readonly kind: 'digit'; readonly value: number }
  | { readonly kind: 'other' };

/** Reads one key at a time from a terminal in raw mode. */
export interface KeyReader {
  /**
   * Waits for one key.
   *
   * @param signal - Aborts the wait
   * @returns The key, or `null` after Ctrl+C, end of input or an abort
   */
  read(signal?: AbortSignal): Promise<PickerKey | null>;
}

/** The parts of a TTY input stream the reader needs. */
export interface RawInput {
  readonly isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
  on(
    event: 'keypress',
    listener: (text: string | undefined, key: KeyInfo | undefined) => void,
  ): unknown;
  on(event: 'end', listener: () => void): unknown;
  off(
    event: 'keypress',
    listener: (text: string | undefined, key: KeyInfo | undefined) => void,
  ): unknown;
  off(event: 'end', listener: () => void): unknown;
  resume(): unknown;
  pause(): unknown;
}

/** What `readline` reports for one keypress. */
export interface KeyInfo {
  readonly name?: string;
  readonly ctrl?: boolean;
  readonly sequence?: string;
}

/**
 * Maps one `readline` keypress to the picker's key, `vi` letters included.
 *
 * @param text - The character typed, when printable
 * @param key - The parsed key
 * @returns The picker key, or `'interrupt'` for Ctrl+C and `'eof'` for Ctrl+D
 */
export function toPickerKey(
  text: string | undefined,
  key: KeyInfo | undefined,
): PickerKey | 'interrupt' | 'eof' {
  if (key?.ctrl === true && key.name === 'c') return 'interrupt';
  if (key?.ctrl === true && key.name === 'd') return 'eof';
  switch (key?.name) {
    case 'up':
    case 'k':
      return { kind: 'up' };
    case 'down':
    case 'j':
      return { kind: 'down' };
    case 'home':
      return { kind: 'home' };
    case 'end':
      return { kind: 'end' };
    case 'return':
    case 'enter':
      return { kind: 'enter' };
    case 'escape':
      return { kind: 'escape' };
    default:
      break;
  }
  if (text !== undefined && /^[1-9]$/.test(text)) return { kind: 'digit', value: Number(text) };
  return { kind: 'other' };
}

/**
 * Builds a key reader over a raw-mode capable input.
 *
 * @param input - The terminal input (`process.stdin`)
 * @param onInterrupt - Called on Ctrl+C, before the read settles with `null`
 * @param beforeRead - Called before a read that waits on the input, to take it
 *   from any other reader (the line reader's interface)
 * @returns The reader, or `undefined` when the input cannot enter raw mode
 */
export function createKeyReader(
  input: RawInput,
  onInterrupt: () => void,
  beforeRead?: () => void,
): KeyReader | undefined {
  if (input.isTTY !== true || typeof input.setRawMode !== 'function') return undefined;
  emitKeypressEvents(input as Parameters<typeof emitKeypressEvents>[0]);
  // `readline` emits every key of one chunk synchronously, so the keys after
  // the first arrive once the read that took the first has settled: they wait
  // here for the next reads. `null` stands for Ctrl+D or the end of input.
  const queued: (PickerKey | null)[] = [];
  let pending: ((value: PickerKey | null) => void) | undefined;
  let listening = false;
  let endListening = false;
  const deliver = (value: PickerKey | null): void => {
    if (pending === undefined) queued.push(value);
    else pending(value);
  };
  const onKey = (text: string | undefined, key: KeyInfo | undefined): void => {
    const mapped = toPickerKey(text, key);
    if (mapped === 'interrupt') {
      // Ctrl+C acts at once, whether a read is waiting or not.
      queued.length = 0;
      deliver(null);
      onInterrupt();
    } else {
      deliver(mapped === 'eof' ? null : mapped);
    }
  };
  const onEnd = (): void => deliver(null);
  // Detached once the read has settled and the chunk that settled it has been
  // delivered: readline emits a chunk's keys synchronously, so a microtask runs
  // after the last of them.
  const release = (): void => {
    queueMicrotask(() => {
      if (pending !== undefined || !listening) return;
      // `end` stays: it consumes no keys, and an end of input between reads
      // must still settle the next read.
      input.off('keypress', onKey);
      listening = false;
    });
  };
  return {
    read(signal) {
      if (signal?.aborted === true) return Promise.resolve(null);
      if (queued.length > 0) return Promise.resolve(queued.shift()!);
      beforeRead?.();
      if (!listening) {
        input.on('keypress', onKey);
        if (!endListening) input.on('end', onEnd);
        endListening = true;
        listening = true;
      }
      return new Promise((resolve) => {
        const finish = (value: PickerKey | null): void => {
          pending = undefined;
          signal?.removeEventListener('abort', onAbort);
          input.setRawMode?.(false);
          input.pause();
          release();
          resolve(value);
        };
        const onAbort = (): void => finish(null);
        pending = finish;
        signal?.addEventListener('abort', onAbort, { once: true });
        input.setRawMode?.(true);
        input.resume();
      });
    },
  };
}

/**
 * The colour level for the picker's highlight: honours `NO_COLOR`
 * (https://no-color.org) and asks the stream which palette it takes.
 *
 * @returns `truecolor` for the gradient, `ansi` for one colour, or `none`
 */
export function supportsColor(
  env: Readonly<Record<string, string | undefined>> = process.env,
  stream: { readonly hasColors?: (count: number) => boolean } = process.stdout,
): PickerColor {
  if (env['NO_COLOR'] !== undefined && env['NO_COLOR'] !== '') return 'none';
  if (stream.hasColors?.(2 ** 24) === true) return 'truecolor';
  return stream.hasColors?.(16) === true ? 'ansi' : 'none';
}

/** The parts of a TTY output stream the picker needs. */
export interface PickerOutput {
  readonly isTTY?: boolean;
  /** The terminal's width, read again for every frame (it changes on resize). */
  readonly columns?: number;
  write(text: string): unknown;
  hasColors?(count: number): boolean;
}

/**
 * The arrow-key list's terminal, when both ends are interactive: keys from a
 * raw-mode input, raw writes to the output, and the output's colour level.
 *
 * @param input - The terminal input (`process.stdin`)
 * @param output - The terminal output (`process.stdout`)
 * @param onInterrupt - Called on Ctrl+C
 * @param env - The environment, for `NO_COLOR`
 * @param beforeRead - Called before each key read that waits, to take the input
 *   from the line reader (see `nodeProcess` in `main.ts`)
 * @returns The picker terminal, or `undefined` to keep the typed answer, also
 * for `TERM=dumb`, which cannot move the cursor to redraw the list
 */
export function createPicker(
  input: RawInput,
  output: PickerOutput,
  onInterrupt: () => void,
  env: Readonly<Record<string, string | undefined>> = process.env,
  beforeRead?: () => void,
): PickerTerminal | undefined {
  if (output.isTTY !== true || env['TERM'] === 'dumb') return undefined;
  const keys = createKeyReader(input, onInterrupt, beforeRead);
  if (keys === undefined) return undefined;
  return {
    keys,
    write: (text) => {
      output.write(text);
    },
    color: supportsColor(env, output),
    columns: () => output.columns,
  };
}
