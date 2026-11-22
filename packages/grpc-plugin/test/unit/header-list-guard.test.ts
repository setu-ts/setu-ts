import { describe, expect, it } from 'vitest';
import { Code, ConnectError } from '@connectrpc/connect';
import { loadConnectModule } from '../../src/transports/connect-loader.ts';
import { callOutcome } from '../../src/client/call-outcome.ts';
import { guardHeaderList, headerListSize } from '../../src/client/header-list-guard.ts';
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
): GuardedStreamLike & { destroyedWith: Error[] } {
  const destroyedWith: Error[] = [];
  return {
    destroyedWith,
    ...(sentHeaders === undefined ? {} : { sentHeaders }),
    session: hasSession
      ? maxHeaderListSize === undefined
        ? {}
        : { remoteSettings: { maxHeaderListSize } }
      : null,
    destroy(error?: Error) {
      if (error !== undefined) destroyedWith.push(error);
    },
  };
}

describe('guardHeaderList', () => {
  const headers = { ':method': 'POST', ':path': '/svc/Method', 'x-big': 'a'.repeat(100) };
  const size = headerListSize(headers);

  it('destroys a stream over the advertised limit with the named caller error', async () => {
    const stream = streamWith(headers, size - 1);
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
    const refusal = new GrpcHeaderListTooLargeError(5000, 4096);
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
