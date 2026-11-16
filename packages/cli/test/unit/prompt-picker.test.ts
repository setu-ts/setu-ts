/**
 * Tests for the arrow-key option list: key mapping, the highlight step,
 * rendering at each colour level, the select loop over a fake terminal, the raw
 * key reader over a fake input, and the colour level a terminal gets.
 *
 * @module
 */

import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';

import {
  createTerminalPrompter,
  gradient,
  highlight,
  pickerStep,
  renderPicker,
  rowsFor,
  type PickerColor,
} from '../../src/prompt.ts';
import {
  createKeyReader,
  createPicker,
  supportsColor,
  toPickerKey,
  type PickerKey,
} from '../../src/terminal-keys.ts';

const CHOICES = [
  { value: 'memory', label: 'memory' },
  { value: 'redis', label: 'redis' },
  { value: 'rabbitmq', label: 'RabbitMQ broker' },
];

/** Strips every escape sequence, leaving what a reader sees. */
const ESCAPE_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, 'g');
const visible = (text: string): string => text.replace(ESCAPE_SEQUENCE, '').replace(/\r/g, '');

/** A picker terminal that plays `keys` in order and records every write. */
function fakeTerminal(keys: readonly (PickerKey | null)[], color: PickerColor = 'none') {
  const writes: string[] = [];
  const queue = [...keys];
  return {
    writes,
    terminal: {
      keys: { read: () => Promise.resolve(queue.length === 0 ? null : queue.shift()!) },
      write: (text: string) => {
        writes.push(text);
      },
      color,
    },
  };
}

const prompterOver = (
  terminal: ReturnType<typeof fakeTerminal>['terminal'],
  signal?: AbortSignal,
) =>
  createTerminalPrompter(
    () => true,
    () => Promise.reject(new Error('the typed prompt must not be used')),
    () => {},
    signal,
    terminal,
  );

describe('toPickerKey', () => {
  it('maps arrows, vi letters, Home, End, Enter, Escape, digits, Ctrl+C and Ctrl+D', () => {
    const cases: readonly [string | undefined, { name?: string; ctrl?: boolean }, unknown][] = [
      [undefined, { name: 'up' }, { kind: 'up' }],
      ['k', { name: 'k' }, { kind: 'up' }],
      [undefined, { name: 'down' }, { kind: 'down' }],
      ['j', { name: 'j' }, { kind: 'down' }],
      [undefined, { name: 'home' }, { kind: 'home' }],
      [undefined, { name: 'end' }, { kind: 'end' }],
      ['\r', { name: 'return' }, { kind: 'enter' }],
      ['\n', { name: 'enter' }, { kind: 'enter' }],
      [undefined, { name: 'escape' }, { kind: 'escape' }],
      ['3', { name: '3' }, { kind: 'digit', value: 3 }],
      ['0', { name: '0' }, { kind: 'other' }],
      ['x', { name: 'x' }, { kind: 'other' }],
      [undefined, { name: 'c', ctrl: true }, 'interrupt'],
      [undefined, { name: 'd', ctrl: true }, 'eof'],
    ];
    for (const [text, key, expected] of cases) expect(toPickerKey(text, key)).toEqual(expected);
    expect(toPickerKey(undefined, undefined)).toEqual({ kind: 'other' });
  });
});

describe('pickerStep', () => {
  it('moves and wraps, jumps, selects and cancels', () => {
    const count = 3;
    expect(pickerStep(0, { kind: 'up' }, count)).toEqual({ index: 2 });
    expect(pickerStep(2, { kind: 'down' }, count)).toEqual({ index: 0 });
    expect(pickerStep(1, { kind: 'down' }, count)).toEqual({ index: 2 });
    expect(pickerStep(2, { kind: 'home' }, count)).toEqual({ index: 0 });
    expect(pickerStep(0, { kind: 'end' }, count)).toEqual({ index: 2 });
    expect(pickerStep(0, { kind: 'digit', value: 2 }, count)).toEqual({ index: 1 });
    expect(pickerStep(1, { kind: 'digit', value: 9 }, count)).toEqual({ index: 1 });
    expect(pickerStep(1, { kind: 'enter' }, count)).toEqual({ index: 1, done: 'select' });
    expect(pickerStep(1, { kind: 'escape' }, count)).toEqual({ index: 1, done: 'cancel' });
    expect(pickerStep(1, { kind: 'other' }, count)).toEqual({ index: 1 });
  });
});

describe('renderPicker', () => {
  it('numbers every option, marks the highlight, and shows a label only when it adds something', () => {
    const lines = renderPicker('Choose the broker', CHOICES, 1, 'none');
    expect(lines).toEqual([
      '? Choose the broker (↑/↓ or a number to move, Enter to choose)',
      '   1. memory',
      ' ❯ 2. redis',
      '   3. rabbitmq — RabbitMQ broker',
    ]);
  });

  it('colours the highlight by level, and reads the same once colour is stripped', () => {
    const plain = renderPicker('Q', CHOICES, 0, 'none');
    for (const level of ['ansi', 'truecolor'] as const) {
      const lines = renderPicker('Q', CHOICES, 0, level);
      expect(lines.map(visible)).toEqual(plain);
      expect(lines[1]).toContain(highlight('❯ 1. memory', level));
    }
    expect(renderPicker('Q', CHOICES, 0, 'truecolor')[1]).toContain('\x1b[38;2;34;211;238m');
    expect(renderPicker('Q', CHOICES, 0, 'ansi')[1]).toContain('\x1b[1;36m');
  });

  it('escapes terminal controls in the question and the choices', () => {
    const [question, option] = renderPicker(
      'a\x1b[2Jb',
      [{ value: 'x\x07', label: 'x\x07' }],
      0,
      'none',
    );
    expect(question).not.toContain('\x1b[2J');
    expect(option).not.toContain('\x07');
  });
});

describe('gradient and highlight', () => {
  it('runs cyan to violet, one colour per character, bold and reset', () => {
    const text = gradient('ab');
    expect(text.startsWith('\x1b[1m\x1b[38;2;34;211;238ma')).toBe(true);
    expect(text).toContain('\x1b[38;2;168;85;247mb');
    expect(text.endsWith('\x1b[0m')).toBe(true);
    expect(visible(gradient('x'))).toBe('x');
    expect(highlight('t', 'none')).toBe('t');
  });
});

describe('createTerminalPrompter with the arrow-key list', () => {
  it('moves with the keys and answers the highlighted value, collapsing to one line', async () => {
    const { terminal, writes } = fakeTerminal([
      { kind: 'down' },
      { kind: 'down' },
      { kind: 'enter' },
    ]);
    expect(await prompterOver(terminal).select('Choose the broker', CHOICES)).toEqual({
      kind: 'answer',
      value: 'rabbitmq',
      shown: true,
    });
    expect(writes[0]).toBe('\x1b[?25l');
    expect(writes.at(-1)).toBe('\x1b[?25h');
    // Each redraw rewinds over the four lines it drew before.
    expect(writes.filter((text) => text.startsWith('\x1b[4A\r\x1b[0J')).length).toBe(3);
    expect(visible(writes.at(-2)!)).toBe('✔ Choose the broker · rabbitmq\n');
  });

  it('cancels on Escape, on an unread key and on an interrupt, restoring the cursor', async () => {
    for (const keys of [[{ kind: 'escape' } as const], [null]]) {
      const { terminal, writes } = fakeTerminal(keys, 'ansi');
      expect(await prompterOver(terminal).select('Q', CHOICES)).toEqual({ kind: 'cancelled' });
      expect(visible(writes.at(-2)!)).toBe('✖ Q\n');
      expect(writes.at(-1)).toBe('\x1b[?25h');
    }
    const aborted = new AbortController();
    aborted.abort();
    const { terminal } = fakeTerminal([{ kind: 'enter' }]);
    expect(await prompterOver(terminal, aborted.signal).select('Q', CHOICES)).toEqual({
      kind: 'cancelled',
    });
  });

  it('cancels when the interrupt fires while a key is awaited', async () => {
    const controller = new AbortController();
    const terminal = {
      keys: {
        read: () => {
          controller.abort();
          return Promise.resolve({ kind: 'enter' } as const);
        },
      },
      write: () => {},
      color: 'none' as const,
    };
    expect(await prompterOver(terminal, controller.signal).select('Q', CHOICES)).toEqual({
      kind: 'cancelled',
    });
  });

  it('keeps the typed answer when there is no key reader, without repeating a label', async () => {
    const lines: string[] = [];
    const prompter = createTerminalPrompter(
      () => true,
      () => Promise.resolve('redis'),
      (line) => lines.push(line),
    );
    expect(await prompter.select('Q', CHOICES)).toEqual({ kind: 'answer', value: 'redis' });
    expect(lines[0]).toBe('  memory\n  redis\n  rabbitmq — RabbitMQ broker');
  });
});

/** A fake raw-mode input: an emitter with the TTY surface the reader uses. */
function fakeInput(tty = true) {
  const emitter = new EventEmitter();
  const modes: boolean[] = [];
  const input = Object.assign(emitter, {
    isTTY: tty,
    setRawMode: (mode: boolean) => {
      modes.push(mode);
    },
    resume: () => {},
    pause: () => {},
  });
  return { input, modes };
}

describe('createKeyReader', () => {
  it('needs a TTY that can enter raw mode', () => {
    expect(createKeyReader(fakeInput(false).input as never, () => {})).toBeUndefined();
    const noRaw = Object.assign(new EventEmitter(), { isTTY: true, resume() {}, pause() {} });
    expect(createKeyReader(noRaw as never, () => {})).toBeUndefined();
  });

  it('reads one key in raw mode and restores the mode before settling', async () => {
    const { input, modes } = fakeInput();
    const reader = createKeyReader(input as never, () => {})!;
    const read = reader.read();
    input.emit('keypress', undefined, { name: 'down' });
    expect(await read).toEqual({ kind: 'down' });
    expect(modes).toEqual([true, false]);
    // The listener goes once the read has settled, and comes back for the next.
    await Promise.resolve();
    expect(input.listenerCount('keypress')).toBe(0);
    await Promise.all([reader.read(), Promise.resolve(input.emit('keypress', 'x', { name: 'x' }))]);
    await Promise.resolve();
    expect(input.listenerCount('keypress')).toBe(0);
  });

  it('never queues keys typed after a read settles, for a later text question', async () => {
    const { input } = fakeInput();
    let taken = 0;
    const reader = createKeyReader(
      input as never,
      () => {},
      () => (taken += 1),
    )!;
    const first = reader.read();
    expect(taken).toBe(1);
    input.emit('keypress', undefined, { name: 'down' });
    expect(await first).toEqual({ kind: 'down' });
    await Promise.resolve();
    // A text question's Enter, typed between two picker reads, is not the picker's.
    input.emit('keypress', '\r', { name: 'return' });
    const second = reader.read();
    expect(taken).toBe(2);
    input.emit('keypress', undefined, { name: 'up' });
    expect(await second).toEqual({ kind: 'up' });
  });

  it('queues the keys of one chunk for the next reads instead of dropping them', async () => {
    const { input, modes } = fakeInput();
    const reader = createKeyReader(input as never, () => {})!;
    const first = reader.read();
    // readline emits a pasted chunk's keys synchronously, one after another.
    input.emit('keypress', undefined, { name: 'down' });
    input.emit('keypress', undefined, { name: 'down' });
    input.emit('keypress', '2', { name: '2' });
    input.emit('keypress', undefined, { name: 'd', ctrl: true });
    expect(await first).toEqual({ kind: 'down' });
    expect(await reader.read()).toEqual({ kind: 'down' });
    expect(await reader.read()).toEqual({ kind: 'digit', value: 2 });
    expect(await reader.read()).toBeNull();
    // Queued keys are served without entering raw mode again.
    expect(modes).toEqual([true, false]);
  });

  it('acts on a queued Ctrl+C at once and drops the keys queued before it', async () => {
    const { input } = fakeInput();
    let interrupts = 0;
    const reader = createKeyReader(input as never, () => (interrupts += 1))!;
    const first = reader.read();
    input.emit('keypress', undefined, { name: 'down' });
    input.emit('keypress', undefined, { name: 'up' });
    input.emit('keypress', undefined, { name: 'c', ctrl: true });
    expect(await first).toEqual({ kind: 'down' });
    expect(interrupts).toBe(1);
    expect(await reader.read()).toBeNull();
    input.emit('end');
    expect(await reader.read()).toBeNull();
  });

  it('reports Ctrl+C through onInterrupt, and settles null on Ctrl+D, end of input and abort', async () => {
    const { input } = fakeInput();
    let interrupts = 0;
    const reader = createKeyReader(input as never, () => (interrupts += 1))!;
    const ctrlC = reader.read();
    input.emit('keypress', undefined, { name: 'c', ctrl: true });
    expect(await ctrlC).toBeNull();
    expect(interrupts).toBe(1);
    const ctrlD = reader.read();
    input.emit('keypress', undefined, { name: 'd', ctrl: true });
    expect(await ctrlD).toBeNull();
    const ended = reader.read();
    input.emit('end');
    expect(await ended).toBeNull();
    const controller = new AbortController();
    const aborted = reader.read(controller.signal);
    controller.abort();
    expect(await aborted).toBeNull();
    const already = new AbortController();
    already.abort();
    expect(await reader.read(already.signal)).toBeNull();
    expect(interrupts).toBe(1);
  });
});

describe('supportsColor', () => {
  it('honours NO_COLOR and asks the stream for 24-bit, then 16 colours', () => {
    const stream = (depth: number) => ({ hasColors: (count: number) => count <= depth });
    expect(supportsColor({ NO_COLOR: '1' }, stream(2 ** 24))).toBe('none');
    expect(supportsColor({ NO_COLOR: '' }, stream(2 ** 24))).toBe('truecolor');
    expect(supportsColor({}, stream(256))).toBe('ansi');
    expect(supportsColor({}, stream(2))).toBe('none');
    expect(supportsColor({}, {})).toBe('none');
  });
});

describe('rowsFor', () => {
  it('counts the rows wrapped lines fill, ignoring escape sequences', () => {
    const long = 'x'.repeat(100);
    expect(rowsFor(['a', 'b'], 80)).toBe(2);
    expect(rowsFor([long, 'b'], 80)).toBe(3);
    expect(rowsFor(['x'.repeat(80)], 80)).toBe(1);
    expect(rowsFor(['x'.repeat(161)], 80)).toBe(3);
    expect(rowsFor([gradient('x'.repeat(80))], 80)).toBe(1);
    expect(rowsFor([''], 80)).toBe(1);
    expect(rowsFor([long], undefined)).toBe(1);
    expect(rowsFor([long], 0)).toBe(1);
  });

  it('rewinds the list past every wrapped row on a redraw', async () => {
    const { writes, terminal } = fakeTerminal([{ kind: 'down' }, { kind: 'enter' }]);
    const narrow = { ...terminal, columns: () => 40 };
    const answer = await prompterOver(narrow).select('Choose the broker for messaging-plugin', [
      ...CHOICES,
    ]);
    expect(answer).toEqual({ kind: 'answer', value: 'redis', shown: true });
    const frame = renderPicker('Choose the broker for messaging-plugin', CHOICES, 0, 'none');
    const rows = rowsFor(frame, 40);
    // The question alone wraps, so the list takes more rows than it has lines.
    expect(rows).toBeGreaterThan(frame.length);
    expect(writes.filter((w) => w.startsWith(`\x1b[${rows}A`))).toHaveLength(2);
  });
});

describe('createPicker', () => {
  it('takes the input from the line reader before a key read waits', async () => {
    const { input } = fakeInput();
    let taken = 0;
    const output = { isTTY: true, write: () => {} };
    const picker = createPicker(
      input as never,
      output,
      () => {},
      {},
      () => (taken += 1),
    )!;
    const read = picker.keys.read();
    expect(taken).toBe(1);
    input.emit('keypress', undefined, { name: 'enter' });
    expect(await read).toEqual({ kind: 'enter' });
  });

  it('needs an interactive output and a raw-mode input, and writes raw to the output', () => {
    const written: string[] = [];
    const output = {
      isTTY: true,
      write: (text: string) => written.push(text),
      hasColors: (count: number) => count <= 256,
    };
    expect(
      createPicker(fakeInput().input as never, { ...output, isTTY: false }, () => {}),
    ).toBeUndefined();
    expect(createPicker(fakeInput(false).input as never, output, () => {})).toBeUndefined();
    const picker = createPicker(fakeInput().input as never, output, () => {}, {})!;
    expect(picker.color).toBe('ansi');
    picker.write('x');
    expect(written).toEqual(['x']);
    expect(
      createPicker(fakeInput().input as never, output, () => {}, { NO_COLOR: '1' })!.color,
    ).toBe('none');
    // A dumb terminal cannot move the cursor, so it keeps the typed answer.
    expect(
      createPicker(fakeInput().input as never, output, () => {}, { TERM: 'dumb' }),
    ).toBeUndefined();
    expect(picker.columns?.()).toBeUndefined();
    expect(
      createPicker(
        fakeInput().input as never,
        { ...output, columns: 72 },
        () => {},
        {},
      )!.columns?.(),
    ).toBe(72);
  });
});
