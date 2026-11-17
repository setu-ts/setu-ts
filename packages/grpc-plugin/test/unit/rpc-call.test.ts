import { describe, expect, it } from 'vitest';

import {
  bodyIterable,
  callFromRequest,
  iterableStream,
  replyFromUniversal,
  responseFromReply,
  textReply,
  universalRequest,
} from '../../src/transports/rpc-call.ts';

async function collect(iterable: AsyncIterable<Uint8Array>): Promise<number[][]> {
  const out: number[][] = [];
  for await (const chunk of iterable) out.push([...chunk]);
  return out;
}

async function* chunks(...parts: number[][]): AsyncIterable<Uint8Array> {
  for (const part of parts) yield new Uint8Array(part);
}

describe('rpc-call conversions', () => {
  it('yields whole bytes once, an empty body never, and a stream chunk by chunk', async () => {
    expect(await collect(bodyIterable(new Uint8Array([1, 2])))).toEqual([[1, 2]]);
    expect(await collect(bodyIterable(new Uint8Array(0)))).toEqual([]);
    const stream = iterableStream(chunks([1], [2, 3]));
    expect(await collect(bodyIterable(stream))).toEqual([[1], [2, 3]]);
  });

  it('builds a universal request carrying the signal only when one is handed', () => {
    const call = {
      method: 'POST',
      url: 'http://h/a.B/C',
      path: '/a.B/C',
      headers: new Headers({ 'content-type': 'application/proto' }),
      body: new Uint8Array(0),
    };
    const signal = new AbortController().signal;
    expect(universalRequest(call, signal).signal).toBe(signal);
    const plain = universalRequest(call);
    expect('signal' in plain).toBe(false);
    expect(plain.header).toBe(call.headers);
    expect(plain.httpVersion).toBe('');
  });

  it('gathers a single reply, joins several chunks, and gives null for no body', async () => {
    const one = await replyFromUniversal({ status: 200, body: chunks([7]) }, false);
    expect([...(one.body as Uint8Array)]).toEqual([7]);
    expect(one.headers).toBeInstanceOf(Headers);
    const joined = await replyFromUniversal({ status: 200, body: chunks([1], [2, 3]) }, false);
    expect([...(joined.body as Uint8Array)]).toEqual([1, 2, 3]);
    const none = await replyFromUniversal({ status: 204, header: new Headers({ a: 'b' }) }, true);
    expect(none).toMatchObject({ status: 204, body: null });
    expect(none.headers.get('a')).toBe('b');
  });

  it('streams a streaming reply and returns the iterator when the stream is cancelled', async () => {
    let finished = false;
    async function* forever(): AsyncIterable<Uint8Array> {
      try {
        for (;;) yield new Uint8Array([9]);
      } finally {
        finished = true;
      }
    }
    const reply = await replyFromUniversal({ status: 200, body: forever() }, true);
    expect(reply.body).toBeInstanceOf(ReadableStream);
    const reader = (reply.body as ReadableStream<Uint8Array>).getReader();
    expect([...(await reader.read()).value!]).toEqual([9]);
    await reader.cancel();
    expect(finished).toBe(true);
  });

  it('answers plain text as a fetch Response would', () => {
    const reply = textReply(404, 'Not Found');
    expect(reply.headers.get('content-type')).toBe('text/plain;charset=UTF-8');
    expect(new TextDecoder().decode(reply.body as Uint8Array)).toBe('Not Found');
  });

  it('reads a non-streaming request whole and passes a streaming body through', async () => {
    const whole = await callFromRequest(
      new Request('http://h/a.B/C?x=1', { method: 'POST', body: new Uint8Array([4]) }),
      false,
    );
    expect(whole.path).toBe('/a.B/C');
    expect([...(whole.body as Uint8Array)]).toEqual([4]);
    const body = iterableStream(chunks([5]));
    const streamed = await callFromRequest(
      new Request('http://h/a.B/D', { method: 'POST', body, duplex: 'half' } as RequestInit),
      true,
    );
    expect(streamed.body).toBeInstanceOf(ReadableStream);
    const empty = await callFromRequest(new Request('http://h/a.B/D', { method: 'POST' }), true);
    expect(empty.body).toBeInstanceOf(Uint8Array);
  });

  it('turns a reply back into a Response, keeping status, headers and body', async () => {
    const response = responseFromReply(textReply(503, 'Service Unavailable'));
    expect(response.status).toBe(503);
    expect(response.headers.get('content-type')).toBe('text/plain;charset=UTF-8');
    expect(await response.text()).toBe('Service Unavailable');
  });
});
