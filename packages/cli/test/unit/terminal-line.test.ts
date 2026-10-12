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
  const read = createLineReader({
    input,
    output,
    terminal,
    onInterrupt: () => {
      interrupts++;
    },
  });
  return {
    input,
    read,
    written: () => written,
    interrupts: () => interrupts,
    open: () => input.listenerCount('data') + input.listenerCount('keypress'),
  };
}

describe('createLineReader', () => {
  it('resolves the line typed after writing the question', async () => {
    const h = harness();
    const answer = h.read('Template? ');
    h.input.write('microservice\n');
    expect(await answer).toBe('microservice');
    expect(h.written()).toContain('Template? ');
  });

  it('resolves an empty string for a bare Enter', async () => {
    const h = harness();
    const answer = h.read('Q? ');
    h.input.write('\n');
    expect(await answer).toBe('');
  });

  it('resolves null at EOF', async () => {
    const h = harness();
    const answer = h.read('Q? ');
    h.input.end();
    expect(await answer).toBeNull();
  });

  it('resolves null without asking when the signal has already aborted', async () => {
    const h = harness();
    const controller = new AbortController();
    controller.abort();
    expect(await h.read('Q? ', controller.signal)).toBeNull();
    expect(h.written()).toBe('');
  });

  it('resolves null when the signal aborts while the question waits', async () => {
    const h = harness();
    const controller = new AbortController();
    const answer = h.read('Q? ', controller.signal);
    controller.abort();
    expect(await answer).toBeNull();
  });

  it('translates a terminal Ctrl+C into the interrupt hook and resolves null', async () => {
    const h = harness(true);
    const answer = h.read('Q? ');
    // ETX is what a raw-mode terminal sends for Ctrl+C; readline emits its own
    // 'SIGINT' event for it rather than raising a process signal.
    h.input.write('\u0003');
    expect(await answer).toBeNull();
    expect(h.interrupts()).toBe(1);
  });

  it('releases the input in every outcome, so it never keeps the process alive', async () => {
    const h = harness();
    const answered = h.read('Q? ');
    h.input.write('a\n');
    await answered;
    expect(h.open()).toBe(0);

    const controller = new AbortController();
    const aborted = h.read('Q? ', controller.signal);
    controller.abort();
    await aborted;
    expect(h.open()).toBe(0);
  });

  it('reads successive questions from one stream', async () => {
    const h = harness();
    const first = h.read('A? ');
    h.input.write('one\n');
    expect(await first).toBe('one');
    const second = h.read('B? ');
    h.input.write('two\n');
    expect(await second).toBe('two');
  });
});
