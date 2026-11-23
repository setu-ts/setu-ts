import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { Code, ConnectError } from '@connectrpc/connect';
import { loadConnectModule } from '../../src/transports/connect-loader.ts';
import { callOutcome, isRefusedStream } from '../../src/client/call-outcome.ts';
import {
  ADVERTISED_LIMIT_FLOOR,
  guardHeaderList,
  headerListSize,
  UNADVERTISED_HEADER_LIST_LIMIT,
} from '../../src/client/header-list-guard.ts';
import type { GuardedStreamLike } from '../../src/client/header-list-guard.ts';
import { GrpcHeaderListTooLargeError } from '../../src/errors/grpc-errors.ts';

describe('headerListSize', () => {
  it('counts name and value octets plus 32 per field (RFC 7541 §4.1), once per value', () => {
    expect(headerListSize({})).toBe(0);
    expect(headerListSize({ ':path': '/x' })).toBe(5 + 2 + 32);
    expect(headerListSize({ a: ['1', '22'] })).toBe(1 + 1 + 32 + (1 + 2 + 32));
    expect(headerListSize({ 'x-é': 'ü', skipped: undefined, n: 7 })).toBe(
      4 + 2 + 32 + (1 + 1 + 32),
    );
  });
});

/** A session whose `request` resolves the given stream. */
function sessionFor(stream: GuardedStreamLike): { request(): Promise<GuardedStreamLike> } {
  return { request: () => Promise.resolve(stream) };
}

/** A stream recording what it was destroyed with. */
function streamWith(
  sentHeaders: Record<string, unknown> | undefined,
  maxHeaderListSize: number | undefined,
  hasSession = true,
): GuardedStreamLike & EventEmitter & { destroyedWith: Error[]; rstCode: number } {
  const destroyedWith: Error[] = [];
  return Object.assign(new EventEmitter(), {
    destroyedWith,
    rstCode: 0,
    ...(sentHeaders === undefined ? {} : { sentHeaders }),
    session: hasSession
      ? maxHeaderListSize === undefined
        ? {}
        : { remoteSettings: { maxHeaderListSize } }
      : null,
    destroy(error?: Error) {
      if (error !== undefined) destroyedWith.push(error);
    },
  });
}

describe('guardHeaderList', () => {
  const headers = { ':method': 'POST', ':path': '/svc/Method', 'x-big': 'a'.repeat(100) };
  const size = headerListSize(headers);

  // One decision table covers the advertised/no-limit × size × reaction rule.
  // Refusal with/without error and with a late rstCode: the first error settles Connect.
  const cases = [
    { advertised: true, size: 65535, reaction: 'refused', result: 'refused' },
    { advertised: true, size: 65535, reaction: 'answer', result: 'passes' },
    { advertised: true, size: 65536, reaction: 'refused', result: 'refused' },
    { advertised: true, size: 65536, reaction: 'answer', result: 'passes' },
    { advertised: true, size: 65537, reaction: 'refused', result: 'caller' },
    { advertised: true, size: 65537, reaction: 'answer', result: 'caller' },
    { advertised: false, size: 65535, reaction: 'refused', result: 'refused' },
    { advertised: false, size: 65535, reaction: 'answer', result: 'passes' },
    { advertised: false, size: 65536, reaction: 'refused', result: 'refused' },
    { advertised: false, size: 65536, reaction: 'answer', result: 'passes' },
    { advertised: false, size: 65537, reaction: 'refused', result: 'caller' },
    {
      advertised: false,
      size: 65537,
      reaction: 'refused',
      sessionState: 'closed',
      result: 'refused',
    },
    {
      advertised: false,
      size: 65537,
      reaction: 'refused',
      sessionState: 'destroyed',
      result: 'refused',
    },
    { advertised: false, size: 65537, reaction: 'answer', result: 'passes' },
    { advertised: true, limit: 1024, size: 8191, reaction: 'answer', result: 'instance' },
    { advertised: true, limit: 1024, size: 8192, reaction: 'answer', result: 'instance' },
    { advertised: true, limit: 1024, size: 8193, reaction: 'answer', result: 'caller' },
    { advertised: true, limit: 16384, size: 16385, reaction: 'answer', result: 'caller' },
    { advertised: true, limit: 1024, size: 1024, reaction: 'answer', result: 'passes' },
    { advertised: true, limit: 1024, size: 1023, reaction: 'answer', result: 'passes' },
  ] as const;

  for (const row of cases) {
    for (const order of [
      'error-close',
      'error-before-rst-close',
      'close-only',
      'destroy-error-close',
    ] as const) {
      it(`${JSON.stringify(row)} (${order})`, async () => {
        const runtime = await loadConnectModule();
        expect(UNADVERTISED_HEADER_LIST_LIMIT).toBe(65536);
        expect(ADVERTISED_LIMIT_FLOOR).toBe(8192);
        const sent = { x: 'a'.repeat(row.size - 33) };
        expect(headerListSize(sent)).toBe(row.size);
        const limit = 'limit' in row ? row.limit : 65536;
        const stream = streamWith(sent, row.advertised ? limit : 4294967295);
        const session = sessionFor(stream);
        guardHeaderList(session);
        await session.request();
        // GOAWAY can shut down the session after the call starts, before its refusal.
        if ('sessionState' in row) Object.assign(stream.session!, { [row.sessionState]: true });
        const nativeRefusal = Object.assign(
          new Error('Stream closed with error code NGHTTP2_REFUSED_STREAM'),
          { code: 'ERR_HTTP2_STREAM_ERROR' },
        );
        let settled: Error | undefined = stream.destroyedWith[0];
        const errors: Error[] = [];
        stream.on('error', (error: Error) => {
          errors.push(error);
          settled ??= error;
        });
        stream.on('close', () => {
          if (stream.rstCode === 7)
            settled ??= new ConnectError(
              'http/2 stream closed with error code REFUSED_STREAM (0x7)',
              Code.Unavailable,
            );
        });
        let answered = false;
        stream.on('response', () => {
          answered = true;
        });
        if (stream.destroyedWith.length === 0) {
          if (row.reaction === 'refused') {
            if (order === 'error-close' || order === 'destroy-error-close') stream.rstCode = 7;
            if (order === 'destroy-error-close') stream.destroy(nativeRefusal);
            if (order !== 'close-only')
              stream.emit('error', stream.destroyedWith[0] ?? nativeRefusal);
            stream.rstCode = 7;
          } else stream.emit('response', { ':status': 200 });
          stream.emit('close');
        }
        if (row.result === 'passes') {
          expect(settled).toBeUndefined();
          expect(answered).toBe(true);
          expect(errors).toEqual([]);
          return;
        }
        expect(answered).toBe(false);
        const wrapped = ConnectError.from(settled);
        expect(callOutcome(wrapped, undefined, runtime.isWireError)).toBe(
          row.result === 'caller' ? undefined : 'failure',
        );
        // grpc-client's resend branch uses precisely this cause-chain predicate.
        expect(isRefusedStream(wrapped)).toBe(
          row.result === 'refused' || row.result === 'instance',
        );
        if ('sessionState' in row) {
          expect(settled).not.toBeInstanceOf(GrpcHeaderListTooLargeError);
          if (order !== 'close-only') {
            expect(settled).toBe(nativeRefusal);
            expect(errors).toEqual([nativeRefusal]);
          }
          if (order === 'destroy-error-close')
            expect(stream.destroyedWith).toEqual([nativeRefusal]);
        }
        if (row.result === 'instance') {
          expect(settled).not.toBeInstanceOf(GrpcHeaderListTooLargeError);
          expect(settled?.cause).toBeUndefined();
          expect(wrapped.message).toContain(`${row.size} octets`);
          expect(wrapped.message).toContain(`${limit}-octet advertised limit`);
          expect(stream.destroyedWith).toEqual([settled]);
        }
        if (row.result === 'caller') {
          expect(settled).toBeInstanceOf(GrpcHeaderListTooLargeError);
          expect(settled).toMatchObject({ size: row.size, limit });
          expect(settled?.cause).toBeUndefined();
          if (!row.advertised) {
            expect(settled?.message).toContain(
              'no header-list limit was known when the call started',
            );
            expect(settled?.message).toContain(`${row.size} octets`);
            expect(settled?.message).toContain('65536-octet threshold');
            expect(errors).toHaveLength(1);
          }
        }
      });
    }
  }

  it('replaces a refusal before destroy can deliver it to a pending write callback', async () => {
    const stream = streamWith({ x: 'a'.repeat(65504) }, 4294967295);
    let writeError: Error | undefined;
    stream.destroy = (error?: Error) => {
      writeError = error;
      stream.emit('error', error);
      stream.emit('close');
    };
    const session = sessionFor(stream);
    guardHeaderList(session);
    await session.request();
    const events: Error[] = [];
    stream.on('error', (e: Error) => events.push(e));
    stream.rstCode = 7;
    stream.destroy();
    expect(writeError).toBeInstanceOf(GrpcHeaderListTooLargeError);
    expect(writeError).toMatchObject({ size: 65537, limit: 65536 });
    expect(events).toEqual([writeError]);
    expect(isRefusedStream(ConnectError.from(writeError))).toBe(false);
    expect(callOutcome(ConnectError.from(writeError), undefined, () => false)).toBeUndefined();
  });

  it('does not reclassify a different reset, a caller abort, or an unrelated error', async () => {
    for (const rstCode of [0, 2, 8]) {
      const stream = streamWith({ x: 'a'.repeat(65537) }, 4294967295);
      const session = sessionFor(stream);
      guardHeaderList(session);
      await session.request();
      const error = new Error('unrelated');
      const seen: Error[] = [];
      stream.on('error', (e: Error) => seen.push(e));
      stream.rstCode = rstCode;
      stream.destroy(error);
      expect(stream.destroyedWith).toEqual([error]);
      stream.emit('error', error);
      stream.emit('close');
      expect(seen).toEqual([error]);
    }
  });

  it('destroys a stream over the advertised limit with the named caller error', async () => {
    const large = { x: 'a'.repeat(8193 - 33) };
    const size = headerListSize(large);
    const stream = streamWith(large, size - 1);
    const session = sessionFor(stream);
    guardHeaderList(session);
    expect(await session.request()).toBe(stream);
    expect(stream.destroyedWith).toHaveLength(1);
    const error = stream.destroyedWith[0]!;
    expect(error).toBeInstanceOf(GrpcHeaderListTooLargeError);
    expect((error as GrpcHeaderListTooLargeError).size).toBe(size);
    expect((error as GrpcHeaderListTooLargeError).limit).toBe(size - 1);
    expect(error.name).toBe('GrpcHeaderListTooLargeError');
  });

  it('leaves a stream at or under the limit, with no advertised limit, or without settings', async () => {
    for (const stream of [
      streamWith(headers, size),
      streamWith(headers, 4294967295),
      streamWith(headers, undefined),
      streamWith(headers, size - 1, false),
      streamWith(undefined, 10),
    ]) {
      const session = sessionFor(stream);
      guardHeaderList(session);
      await session.request();
      expect(stream.destroyedWith).toEqual([]);
    }
  });

  it('is never reported against an instance when it reaches the call outcome', async () => {
    const runtime = await loadConnectModule();
    const refusal = new GrpcHeaderListTooLargeError(8193, 4096);
    const wrapped = new ConnectError(refusal.message, Code.Internal, undefined, undefined, refusal);
    expect(callOutcome(wrapped, undefined, runtime.isWireError)).toBeUndefined();
    const deep = new ConnectError(
      'x',
      Code.Unknown,
      { a: '1' },
      undefined,
      new Error('w', { cause: refusal }),
    );
    expect(callOutcome(deep, undefined, runtime.isWireError)).toBeUndefined();
    let tooDeep: unknown = refusal;
    for (let n = 0; n < 5; n++) tooDeep = new Error('wrapper', { cause: tooDeep });
    expect(
      callOutcome(
        new ConnectError('x', Code.Internal, undefined, undefined, tooDeep),
        undefined,
        runtime.isWireError,
      ),
    ).toBe('failure');
  });
});
