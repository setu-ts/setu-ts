/**
 * Unit tests for the newline-delimited JSON reader.
 *
 * The chunk-boundary case is the point of the file: a watch stream routinely
 * splits an object across two network chunks, and a reader that parsed each
 * chunk independently would be intermittently broken under load.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { readJsonLines } from '../../src/http/ndjson.ts';
import { streamOf } from '../fixtures/fakes.ts';

async function collect(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const value of readJsonLines(stream, signal)) {
    out.push(value);
  }
  return out;
}

describe('readJsonLines', () => {
  it('reassembles one object split across two chunks', async () => {
    const values = await collect(streamOf(['{"type":"MODI', 'FIED"}\n']));
    expect(values).toEqual([{ type: 'MODIFIED' }]);
  });

  it('yields several objects delivered in one chunk', async () => {
    const values = await collect(streamOf(['{"a":1}\n{"a":2}\n{"a":3}\n']));
    expect(values).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }]);
  });

  it('discards a trailing partial line at end of stream', async () => {
    const values = await collect(streamOf(['{"a":1}\n{"a":']));
    expect(values).toEqual([{ a: 1 }]);
  });

  it('skips a complete but unparseable line rather than throwing', async () => {
    const values = await collect(streamOf(['not json\n{"a":1}\n']));
    expect(values).toEqual([{ a: 1 }]);
  });

  it('ignores blank lines', async () => {
    const values = await collect(streamOf(['\n\n{"a":1}\n\n']));
    expect(values).toEqual([{ a: 1 }]);
  });

  it('ends immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const values = await collect(streamOf(['{"a":1}\n']), controller.signal);
    expect(values).toEqual([]);
  });

  it('stops once the signal aborts mid-stream', async () => {
    const controller = new AbortController();
    const out: unknown[] = [];
    for await (
      const value of readJsonLines(streamOf(['{"a":1}\n', '{"a":2}\n']), controller.signal)
    ) {
      out.push(value);
      controller.abort();
    }
    expect(out).toEqual([{ a: 1 }]);
  });
});
