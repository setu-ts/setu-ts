import { expect, it } from 'vitest';
import { Code, ConnectError } from '@connectrpc/connect';
import { errorFromJson } from '@connectrpc/connect/protocol-connect';
import { loadConnectModule } from '../../src/transports/connect-loader.ts';
import { callOutcome, GRPC_CODE } from '../../src/client/call-outcome.ts';

it('keeps the frozen canonical code table equal to the real Connect enum', () => {
  expect(Object.isFrozen(GRPC_CODE)).toBe(true);
  for (const [name, code] of Object.entries(GRPC_CODE)) {
    expect(code, name).toBe(Code[name as keyof typeof GRPC_CODE]);
  }
});

const rows = [
  [Code.Canceled, 'failure'],
  [Code.Unknown, 'failure'],
  [Code.InvalidArgument, 'success'],
  [Code.DeadlineExceeded, 'failure'],
  [Code.NotFound, 'success'],
  [Code.AlreadyExists, 'success'],
  [Code.PermissionDenied, 'success'],
  [Code.ResourceExhausted, 'success'],
  [Code.FailedPrecondition, 'success'],
  [Code.Aborted, 'success'],
  [Code.OutOfRange, 'success'],
  [Code.Unimplemented, 'failure'],
  [Code.Internal, 'failure'],
  [Code.Unavailable, 'failure'],
  [Code.DataLoss, 'failure'],
  [Code.Unauthenticated, 'success'],
] as const;

it('has exactly one row for every code in the real Connect enum', () => {
  expect(rows.map(([code]) => code).sort((a, b) => a - b)).toEqual(
    Object.values(Code)
      .filter((code) => typeof code === 'number')
      .sort((a, b) => a - b),
  );
});
for (const [code, wireOutcome] of rows) {
  for (const wire of [false, true]) {
    it(`classifies ${Code[code]} with isWireError=${wire}`, async () => {
      const runtime = await loadConnectModule();
      const fallback = new ConnectError(
        'answer',
        code,
        new Headers({ 'content-type': 'application/grpc' }),
      );
      const jsonFallback = wire && (code === Code.Unimplemented || code === Code.Unavailable);
      const error = jsonFallback ? errorFromJson({}, undefined, fallback) : fallback;
      if (jsonFallback) expect(error.isWireError).toBe(true);
      else error.isWireError = wire;
      expect(callOutcome(error, undefined, runtime.isWireError)).toBe(
        wire ? wireOutcome : 'failure',
      );
    });
  }
}
it('gives caller abort first priority, refused streams second, and defaults unknown errors to failure', () => {
  const abort = new AbortController();
  abort.abort();
  const refused = Object.assign(new Error('NGHTTP2_REFUSED_STREAM'), {
    code: 'ERR_HTTP2_STREAM_ERROR',
  });
  expect(callOutcome(refused, abort.signal, () => true)).toBeUndefined();
  expect(callOutcome(refused, undefined, () => true)).toBe('failure');
  for (const error of [null, 'bad', {}, { code: 0 }, { code: 999 }]) {
    expect(callOutcome(error, undefined, () => true)).toBe('failure');
    expect(callOutcome(error, undefined, () => false)).toBe('failure');
  }
});

it('does not attribute local serialization or write-limit faults to the instance', async () => {
  const runtime = await loadConnectModule();
  const serialization = ConnectError.from(new Error('cannot serialize request'), Code.Internal);
  const writeLimit = new ConnectError(
    'message size 10 is larger than configured writeMaxBytes 1',
    Code.ResourceExhausted,
  );
  for (const error of [serialization, writeLimit]) {
    expect(error.metadata.keys().next().done).toBe(true);
    expect(callOutcome(error, undefined, runtime.isWireError)).toBeUndefined();
  }
});

it('reports unclassified non-wire errors as failures regardless of metadata or system causes', async () => {
  const runtime = await loadConnectModule();
  for (const code of ['ECONNRESET', 'ECONNREFUSED', 'ERR_HTTP2_STREAM_ERROR']) {
    const system = Object.assign(new Error('system fault'), { code });
    const error = new ConnectError(
      'transport',
      Code.Internal,
      undefined,
      undefined,
      new Error('wrapper', { cause: system }),
    );
    expect(callOutcome(error, undefined, runtime.isWireError)).toBe('failure');
  }
  const headers = new ConnectError('HTTP 404', Code.Unimplemented, {
    'content-type': 'text/plain',
  });
  expect(callOutcome(headers, undefined, runtime.isWireError)).toBe('failure');
  let cause: Error = Object.assign(new Error('deep'), { code: 'ECONNRESET' });
  for (let n = 0; n < 5; n++) cause = new Error('wrapper', { cause });
  expect(callOutcome(cause, undefined, runtime.isWireError)).toBe('failure');
  expect(
    callOutcome(Object.assign(new Error(), { cause: null }), undefined, runtime.isWireError),
  ).toBe('failure');
});

for (const [message, code] of [
  ['unsupported content type text/plain', Code.Unknown],
  ['protocol error: missing output message for unary method', Code.Unknown],
  ['protocol error: missing output message for unary method', Code.Unimplemented],
  ['protocol error: received output message for unary method with error status', Code.Unknown],
  [
    'http/2 stream closed with error code NO_ERROR (0x0) before the response was received',
    Code.Internal,
  ],
  ['connection establishment timed out', Code.Unavailable],
  ['PING timed out', Code.Unavailable],
] as const) {
  it(`reports Connect's metadata-free peer error: ${message} (${code})`, async () => {
    const runtime = await loadConnectModule();
    const error = new ConnectError(message, code);
    expect(error.metadata.keys().next().done).toBe(true);
    expect(callOutcome(error, undefined, runtime.isWireError)).toBe('failure');
  });
}

it('limits the serialization/write-limit exclusions to their message, code and absent metadata', async () => {
  const runtime = await loadConnectModule();
  const serialization = 'serialize binary: invalid request';
  const limit = 'message size 10 is larger than configured writeMaxBytes 1';
  for (const error of [
    new ConnectError(serialization, Code.Internal),
    ConnectError.from(new TypeError('invalid JSON request'), Code.Internal),
    new ConnectError(limit, Code.ResourceExhausted),
  ])
    expect(callOutcome(error, undefined, runtime.isWireError)).toBeUndefined();
  for (const error of [
    new ConnectError('parse binary: bad response', Code.Internal),
    new ConnectError('serialize binary:invalid request', Code.Internal),
    new ConnectError(serialization, Code.Unknown),
    new ConnectError(serialization, Code.Internal, { 'content-type': 'application/grpc' }),
    new ConnectError(limit, Code.Internal),
    new ConnectError(limit, Code.ResourceExhausted, { 'grpc-status': '8' }),
    new ConnectError(
      'message size is larger than configured readMaxBytes 1',
      Code.ResourceExhausted,
    ),
    new ConnectError('generic internal', Code.Internal),
    new ConnectError(
      'different message',
      Code.Internal,
      undefined,
      undefined,
      new Error('cause message'),
    ),
    Object.assign(new Error('not a Connect error'), { code: Code.Internal, metadata: {} }),
  ])
    expect(callOutcome(error, undefined, runtime.isWireError)).toBe('failure');
});

it('does not attribute a caller header node:http2 refuses before sending to the instance', async () => {
  const runtime = await loadConnectModule();
  const http2 = await import('node:http2');
  const server = http2.createServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const session = http2.connect(`http://localhost:${port}`);
  const refusals: unknown[] = [];
  const headers: readonly Record<string, string | string[]>[] = [
    { connection: 'close' },
    { 'bad header': 'x' },
    { host: ['a', 'b'] },
  ];
  for (const header of headers) {
    try {
      session.request({ ':path': '/', ...header });
    } catch (error) {
      refusals.push(error);
    }
  }
  session.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  expect(refusals.map((error) => (error as { code?: unknown }).code)).toEqual([
    'ERR_HTTP2_INVALID_CONNECTION_HEADERS',
    'ERR_INVALID_HTTP_TOKEN',
    'ERR_HTTP2_HEADER_SINGLE_VALUE',
  ]);
  for (const cause of refusals) {
    const wrapped = new ConnectError('request failed', Code.Internal, undefined, undefined, cause);
    expect(callOutcome(wrapped, undefined, runtime.isWireError)).toBeUndefined();
    const deep = new ConnectError(
      'request failed',
      Code.Unknown,
      undefined,
      undefined,
      new Error('wrapper', { cause }),
    );
    expect(callOutcome(deep, undefined, runtime.isWireError)).toBeUndefined();
  }
  const other = new ConnectError(
    'request failed',
    Code.Internal,
    undefined,
    undefined,
    Object.assign(new Error('reset'), { code: 'ECONNRESET' }),
  );
  expect(callOutcome(other, undefined, runtime.isWireError)).toBe('failure');
});
