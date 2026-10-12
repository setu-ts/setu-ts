/**
 * Unit tests for the Node adapter's content-type parity seam: deciding when a
 * response carries no native type, and removing the default node-server adds.
 *
 * @module
 */

import type { IResponse, ResponseSnapshot } from '@setu-ts/common';
import { describe, expect, it } from 'vitest';
import {
  lacksNativeContentType,
  NodeHttpServerHandle,
  type NodeOutgoing,
  suppressDefaultContentType,
} from '../../src/adapters/node/node-http-adapter.ts';

const BYTES = new Uint8Array([1]);

function snap(
  body: ResponseSnapshot['body'],
  headers: Headers = new Headers(),
  init?: HeadersInit,
): ResponseSnapshot {
  const base = {
    status: 200,
    headers,
    ...(init === undefined ? {} : { responseInit: { headers: init } }),
  };
  return body instanceof ReadableStream
    ? { ...base, streaming: true, body }
    : { ...base, streaming: false, body };
}

/** A fake outgoing that records every writeHead call. */
function recordingOutgoing(): NodeOutgoing & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  return {
    calls,
    writeHead(status, ...rest) {
      calls.push([
        status,
        ...rest.map((arg) =>
          typeof arg === 'object' && arg !== null && !Array.isArray(arg) ? { ...arg } : arg
        ),
      ]);
      return this;
    },
  };
}

describe('lacksNativeContentType', () => {
  // Only bytes and streams lack a type natively; a string body has one, and a
  // null body has nothing to label.
  const cases: [string, ResponseSnapshot, boolean][] = [
    ['null body', snap(null), false],
    ['string body', snap('x'), false],
    ['bytes, live headers without a type', snap(BYTES), true],
    ['bytes, live headers with a type', snap(BYTES, new Headers({ 'Content-Type': 'a/b' })), false],
    [
      'stream, Headers init without a type',
      snap(new ReadableStream(), new Headers(), new Headers()),
      true,
    ],
    [
      'stream, Headers init with a type',
      snap(new ReadableStream(), new Headers(), new Headers({ 'content-type': 'a/b' })),
      false,
    ],
    ['bytes, pair init without a type', snap(BYTES, new Headers(), [['x-a', '1']]), true],
    ['bytes, pair init with a type', snap(BYTES, new Headers(), [['Content-Type', 'a/b']]), false],
    ['bytes, record init without a type', snap(BYTES, new Headers(), { 'x-a': '1' }), true],
    [
      'bytes, record init with a type',
      snap(BYTES, new Headers(), { 'CONTENT-TYPE': 'a/b' }),
      false,
    ],
  ];
  for (const [name, snapshot, expected] of cases) {
    it(name, () => {
      expect(lacksNativeContentType(snapshot)).toBe(expected);
    });
  }

  it('reads the init, not the live headers, when both are present', () => {
    // The live view carries a type the native response will never see.
    const snapshot = snap(BYTES, new Headers({ 'content-type': 'a/b' }), {});
    expect(lacksNativeContentType(snapshot)).toBe(true);
  });
});

describe('suppressDefaultContentType', () => {
  it('removes every spelling of content-type from the next head only', () => {
    const outgoing = recordingOutgoing();
    suppressDefaultContentType(outgoing);
    outgoing.writeHead(200, { 'Content-Type': 'text/plain', 'content-type': 'x', 'x-a': '1' });
    outgoing.writeHead(201, { 'Content-Type': 'text/plain' });
    expect(outgoing.calls).toEqual([
      [200, { 'x-a': '1' }],
      [201, { 'Content-Type': 'text/plain' }],
    ]);
  });

  it('passes a head without headers through and returns what writeHead returns', () => {
    const outgoing = recordingOutgoing();
    suppressDefaultContentType(outgoing);
    expect(outgoing.writeHead(204)).toBe(outgoing);
    expect(outgoing.calls).toEqual([[204]]);
  });

  it("scrubs the record in Node's status-message form and leaves raw arrays alone", () => {
    const outgoing = recordingOutgoing();
    suppressDefaultContentType(outgoing);
    outgoing.writeHead(200, 'OK', { 'Content-Type': 'text/plain', 'x-a': '1' });
    suppressDefaultContentType(outgoing);
    outgoing.writeHead(200, ['Content-Type', 'text/plain']);
    expect(outgoing.calls).toEqual([
      [200, 'OK', { 'x-a': '1' }],
      [200, ['Content-Type', 'text/plain']],
    ]);
  });
});

describe('NodeHttpServerHandle fetch callback', () => {
  function handleAnswering(snapshot: ResponseSnapshot): NodeHttpServerHandle {
    const handle = new NodeHttpServerHandle();
    handle.setHandler(() => ({ snapshot: () => snapshot }) as unknown as IResponse);
    return handle;
  }

  async function headFor(snapshot: ResponseSnapshot, async: boolean) {
    const handle = new NodeHttpServerHandle();
    handle.setHandler(() => {
      const response = { snapshot: () => snapshot } as unknown as IResponse;
      return async ? Promise.resolve(response) : response;
    });
    const outgoing = recordingOutgoing();
    await handle.createFetchHandler()(new Request('http://x/'), { outgoing });
    outgoing.writeHead(200, { 'Content-Type': 'text/plain; charset=UTF-8' });
    return outgoing.calls[0]?.[1];
  }

  it("strips node-server's default for an untyped stream, sync and async", async () => {
    expect(await headFor(snap(new ReadableStream()), false)).toEqual({});
    expect(await headFor(snap(new ReadableStream()), true)).toEqual({});
  });

  it('leaves the head alone for a typed or string response', async () => {
    const kept = { 'Content-Type': 'text/plain; charset=UTF-8' };
    expect(await headFor(snap('x'), false)).toEqual(kept);
    expect(await headFor(snap(BYTES, new Headers({ 'content-type': 'a/b' })), false)).toEqual(kept);
  });

  it('touches nothing when no node-server environment is passed', async () => {
    const response = await handleAnswering(snap(new ReadableStream())).createFetchHandler()(
      new Request('http://x/'),
    );
    expect(response.headers.get('content-type')).toBeNull();
  });
});
