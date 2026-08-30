/** Tests the internal incremental SSE wire parser. */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { SseFrameParser } from '../../src/realtime/sse-frame-parser.ts';

describe('SseFrameParser', () => {
  it('parses a complete event with every supported field', () => {
    const parser = new SseFrameParser();

    expect(parser.push('id: 7\nevent: score\ndata: {"home":1}\nretry: 250\n\n')).toEqual([
      { id: '7', event: 'score', data: '{"home":1}', retry: 250 },
    ]);
  });

  it('joins multi-line data with a newline and strips one optional space', () => {
    const parser = new SseFrameParser();

    expect(parser.push('event: note\ndata: first\ndata:  second\n\n')).toEqual([
      { event: 'note', data: 'first\n second' },
    ]);
  });

  it('accepts a leading BOM and every SSE line ending', () => {
    const parser = new SseFrameParser();

    expect(parser.push('\uFEFFevent: tick\rdata: 1\r\n\r\n')).toEqual([
      { event: 'tick', data: '1' },
    ]);
  });

  it('discards comment frames and does not leak heartbeat payloads', () => {
    const parser = new SseFrameParser();

    expect(parser.push(': heartbeat\n\ndata: {"ok":true}\n\n')).toEqual([
      { data: '{"ok":true}' },
    ]);
  });

  it('retains partial lines and frames until later chunks complete them', () => {
    const parser = new SseFrameParser();

    expect(parser.push('id: resume\ndata: {"n"')).toEqual([]);
    expect(parser.push(':2}\n\n')).toEqual([{ id: 'resume', data: '{"n":2}' }]);
  });

  it('emits a retry-only frame so its consumer can update reconnect delay', () => {
    const parser = new SseFrameParser();

    expect(parser.push('retry: 1000\n\n')).toEqual([{ retry: 1000 }]);
  });

  it('ignores retry values that are not decimal integers', () => {
    const parser = new SseFrameParser();

    expect(parser.push('retry: 1.5\n\nretry: -1\n\nretry: 200\n\n')).toEqual([
      { retry: 200 },
    ]);
  });

  it('ignores id values containing a null character', () => {
    const parser = new SseFrameParser();

    expect(parser.push('id: a\u0000b\ndata: x\n\n')).toEqual([{ data: 'x' }]);
  });
});
