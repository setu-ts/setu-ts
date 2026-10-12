import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLineReader } from '../../src/terminal-line.ts';

/** A reader over in-memory streams, with what it wrote and how often Ctrl+C fired. */
function harness(terminal = false) {
  const input = new PassThrough();
  const output = new PassThrough();
  let written = '';
  output.on('data', (chunk) => {
    written += String(chunk);
  });
  let interrupts = 0;
  const reader = createLineReader({
    input,
    output,
    terminal,
    onInterrupt: () => {
      interrupts++;
    },
  });
  return {
    input,
    reader,
    written: () => written,
    interrupts: () => interrupts,
    open: () => input.listenerCount('data') + input.listenerCount('keypress'),
  };
}

describe('createLineReader', () => {
  it('resolves the line typed after writing the question', async () => {
    const h = harness();
    const answer = h.reader.read('Template? ');
    h.input.write('microservice\n');
    expect(await answer).toBe('microservice');
    expect(h.written()).toContain('Template? ');
    h.reader.close();
  });

  it('resolves an empty string for a bare Enter', async () => {
    const h = harness();
    const answer = h.reader.read('Q? ');
    h.input.write('\n');
    expect(await answer).toBe('');
    h.reader.close();
  });

  it('resolves null at EOF, and for every later question', async () => {
    const h = harness();
    const answer = h.reader.read('Q? ');
    h.input.end();
    expect(await answer).toBeNull();
    expect(await h.reader.read('Again? ')).toBeNull();
  });

  it('resolves null without asking when the signal has already aborted', async () => {
    const h = harness();
    const controller = new AbortController();
    controller.abort();
    expect(await h.reader.read('Q? ', controller.signal)).toBeNull();
    expect(h.written()).toBe('');
  });

  it('resolves null when the signal aborts while the question waits', async () => {
    const h = harness();
    const controller = new AbortController();
    const answer = h.reader.read('Q? ', controller.signal);
    controller.abort();
    expect(await answer).toBeNull();
    h.reader.close();
  });

  it('translates a terminal Ctrl+C into the interrupt hook and resolves null', async () => {
    const h = harness(true);
    const answer = h.reader.read('Q? ');
    // ETX is what a raw-mode terminal sends for Ctrl+C; readline emits its own
    // 'SIGINT' event for it rather than raising a process signal.
    h.input.write('\u0003');
    expect(await answer).toBeNull();
    expect(h.interrupts()).toBe(1);
    h.reader.close();
  });

  it('keeps an answer typed ahead for the next question', async () => {
    // Both answers arrive while the first question is pending; a reader that
    // opened an interface per question lost the second with the first.
    const h = harness();
    const first = h.reader.read('A? ');
    h.input.write('one\ntwo\n');
    expect(await first).toBe('one');
    expect(await h.reader.read('B? ')).toBe('two');
    h.reader.close();
  });

  it('resolves null when the input errors, instead of an uncaught error', async () => {
    const h = harness();
    const answer = h.reader.read('Q? ');
    h.input.destroy(new Error('stdin went away'));
    expect(await answer).toBeNull();
    expect(await h.reader.read('Again? ')).toBeNull();
  });

  it('releases the input on close, so it never keeps the process alive', async () => {
    const h = harness();
    const answered = h.reader.read('Q? ');
    h.input.write('a\n');
    await answered;
    expect(h.open()).toBeGreaterThan(0);
    h.reader.close();
    expect(h.open()).toBe(0);
    expect(await h.reader.read('After? ')).toBeNull();
  });

  it('settles a question still pending when the reader is closed', async () => {
    const h = harness();
    const answer = h.reader.read('Q? ');
    h.reader.close();
    expect(await answer).toBeNull();
  });
});
