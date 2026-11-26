import { expect, it } from 'vitest';
import { findTrailerError, setTrailerStatus } from '@connectrpc/connect/protocol-grpc';
import { Code, ConnectError } from '@connectrpc/connect';
import { codeFromHttpStatus, errorFromJson } from '@connectrpc/connect/protocol-connect';
import { loadConnectModule } from '../../src/transports/connect-loader.ts';
import {
  callOutcome,
  GRPC_CODE,
  isExcessiveLoadReset,
  isRefusedStream,
} from '../../src/client/call-outcome.ts';
import { PeerHeaderListLimitError } from '../../src/client/header-list-guard.ts';
import {
  GrpcExcessiveLoadError,
  GrpcHeaderListTooLargeError,
} from '../../src/errors/grpc-errors.ts';

it('counts an undersized advertised limit as a refused instance fault, but exempts oversized caller headers', async () => {
  const runtime = await loadConnectModule();
  for (const [error, refused, outcome] of [
    [new PeerHeaderListLimitError(8192, 1024), true, 'failure'],
    [new GrpcHeaderListTooLargeError(8193, 1024), false, undefined],
  ] as const) {
    for (const wrapped of [error, ConnectError.from(error)]) {
      expect(isRefusedStream(wrapped)).toBe(refused);
      expect(callOutcome(wrapped, undefined, runtime.isWireError)).toBe(outcome);
    }
  }
});

it('does not resend a server message or an error name imitating the local header-limit refusal', () => {
  const local = new PeerHeaderListLimitError(8192, 1024);
  const server = new ConnectError(local.message, Code.Internal, {
    'content-type': 'application/grpc',
  });
  server.isWireError = true;
  const imitation = Object.assign(new Error(local.message), { name: local.name });
  expect(isRefusedStream(server)).toBe(false);
  expect(isRefusedStream(imitation)).toBe(false);
  expect(callOutcome(server, undefined, () => true)).toBe('success');
  let deep: Error = local;
  for (let n = 0; n < 4; n++) deep = new Error('wrapper', { cause: deep });
  expect(isRefusedStream(deep)).toBe(true);
  expect(isRefusedStream(new Error('too deep', { cause: deep }))).toBe(false);
});

it('keeps the frozen canonical code table equal to the real Connect enum', () => {
  expect(Object.isFrozen(GRPC_CODE)).toBe(true);
  for (const [name, code] of Object.entries(GRPC_CODE)) {
    expect(code, name).toBe(Code[name as keyof typeof GRPC_CODE]);
  }
});

const rows = [
  [Code.Canceled, 'failure'],
  [Code.Unknown, 'success'],
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
  [Code.Internal, 'success'],
  [Code.Unavailable, 'failure'],
  [Code.DataLoss, 'success'],
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
it('counts Internal "internal error" as success only when it is a server answer', async () => {
  const runtime = await loadConnectModule();
  const error = new ConnectError('internal error', Code.Internal);
  error.isWireError = true;
  expect(callOutcome(error, undefined, runtime.isWireError)).toBe('success');
  error.isWireError = false;
  expect(callOutcome(error, undefined, runtime.isWireError)).toBe('failure');
});

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
  const serialization = new ConnectError('serialize binary: cannot encode request', Code.Internal);
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
    new ConnectError(limit, Code.ResourceExhausted),
  ])
    expect(callOutcome(error, undefined, runtime.isWireError)).toBeUndefined();
  for (const error of [
    new ConnectError('parse binary: bad response', Code.Internal),
    new ConnectError('serialize binary:invalid request', Code.Internal),
    // The JSON format is never sent by the client, so its shape is not excluded.
    ConnectError.from(new TypeError('invalid JSON request'), Code.Internal),
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

it('does not attribute a request header Node refuses before sending to the instance', async () => {
  const runtime = await loadConnectModule();
  const http2 = await import('node:http2');
  const http = await import('node:http');
  const refusals: unknown[] = [];
  const server = http2.createServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const session = http2.connect(`http://localhost:${port}`);
  for (const name of [
    'connection',
    'keep-alive',
    'proxy-connection',
    'upgrade',
    'transfer-encoding',
    'http2-settings',
    'te',
  ]) {
    try {
      session.request({ ':path': '/', [name]: 'x' });
    } catch (error) {
      refusals.push(error);
    }
  }
  session.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  try {
    http.request({ host: 'localhost', port: 1, headers: { 'x-a': 'a\u0001b' } });
  } catch (error) {
    refusals.push(error);
  }
  expect(refusals.map((error) => (error as { code?: unknown }).code)).toEqual([
    ...Array<string>(7).fill('ERR_HTTP2_INVALID_CONNECTION_HEADERS'),
    'ERR_INVALID_CHAR',
  ]);
  for (const cause of refusals) {
    const wrapped = new ConnectError('request failed', Code.Internal, undefined, undefined, cause);
    expect(callOutcome(wrapped, undefined, runtime.isWireError)).toBeUndefined();
    const deep = new ConnectError(
      'request failed',
      Code.Unknown,
      { 'x-response': '1' },
      undefined,
      new Error('wrapper', { cause }),
    );
    expect(callOutcome(deep, undefined, runtime.isWireError)).toBeUndefined();
  }
  for (const code of ['ERR_INVALID_HTTP_TOKEN', 'ERR_HTTP2_HEADER_SINGLE_VALUE', 'ECONNRESET']) {
    const other = new ConnectError(
      'request failed',
      Code.Internal,
      undefined,
      undefined,
      Object.assign(new Error('fault'), { code }),
    );
    expect(callOutcome(other, undefined, runtime.isWireError)).toBe('failure');
  }
});

const CALM_NODE = 'Stream closed with error code NGHTTP2_ENHANCE_YOUR_CALM';
const CALM_CONNECT = 'http/2 stream closed with error code ENHANCE_YOUR_CALM (0xb)';
const calmNode = (): Error =>
  Object.assign(new Error(CALM_NODE), { code: 'ERR_HTTP2_STREAM_ERROR' });

// [label, error, isWireError, the matcher's answer, callOutcome]
for (const [label, build, wire, matches, expected] of [
  ["Node's stream error", () => calmNode(), false, true, undefined],
  [
    "Node's stream error under connect's wrapper",
    () =>
      new ConnectError(`[internal] ${CALM_NODE}`, Code.Internal, undefined, undefined, calmNode()),
    false,
    true,
    undefined,
  ],
  [
    "connect-node's reading of the reset code",
    () => new ConnectError(CALM_CONNECT, Code.ResourceExhausted),
    false,
    true,
    undefined,
  ],
  ['the client error itself', () => new GrpcExcessiveLoadError(calmNode()), false, true, undefined],
  [
    'a ConnectError wrapping the client error',
    () =>
      new ConnectError(
        'calm',
        Code.ResourceExhausted,
        undefined,
        undefined,
        new GrpcExcessiveLoadError(),
      ),
    false,
    true,
    undefined,
  ],
  [
    "connect-node's text with response metadata (a server sent it)",
    () =>
      new ConnectError(CALM_CONNECT, Code.ResourceExhausted, {
        'content-type': 'application/grpc',
      }),
    false,
    false,
    'failure',
  ],
  ['the text without the stream-error code', () => new Error(CALM_NODE), false, false, 'failure'],
  [
    'another stream error',
    () => Object.assign(new Error('NGHTTP2_CANCEL'), { code: 'ERR_HTTP2_STREAM_ERROR' }),
    false,
    false,
    'failure',
  ],
  // callOutcome consults the matcher only for errors that are not a server answer.
  ['a wire error copying the text', () => calmNode(), true, true, 'failure'],
  [
    "a wire ResourceExhausted copying connect-node's text",
    () => new ConnectError(CALM_CONNECT, Code.ResourceExhausted),
    true,
    true,
    'success',
  ],
] as const) {
  it(`classifies an ENHANCE_YOUR_CALM shape: ${label} → ${String(expected)}`, () => {
    const error = build();
    expect(isExcessiveLoadReset(error)).toBe(matches);
    expect(callOutcome(error, undefined, () => wire)).toBe(expected);
    expect(isRefusedStream(error)).toBe(false);
  });
}

// The README's rule for a JSON object body on a non-200 unary answer (default `connect`
// protocol), as data: connect reads it as a server answer, its code from the body's `code`
// field or else from the HTTP status, and only Unavailable, Unimplemented,
// DeadlineExceeded and Canceled fail.
for (const [status, body, expected] of [
  [400, {}, 'success'],
  [401, {}, 'success'],
  [403, {}, 'success'],
  [408, {}, 'success'],
  [409, {}, 'success'],
  [500, {}, 'success'],
  [501, {}, 'success'],
  [404, {}, 'failure'],
  [429, {}, 'failure'],
  [502, {}, 'failure'],
  [503, {}, 'failure'],
  [504, {}, 'failure'],
  [500, { code: 'unavailable' }, 'failure'],
  [503, { code: 'not_found' }, 'success'],
  [500, { code: 'canceled' }, 'failure'],
] as const) {
  it(`reads a JSON object on HTTP ${status} ${JSON.stringify(body)} as a server answer → ${expected}`, async () => {
    const runtime = await loadConnectModule();
    const fallback = new ConnectError(`HTTP ${status}`, codeFromHttpStatus(status));
    const error = errorFromJson(body, undefined, fallback);
    expect(error.isWireError).toBe(true);
    expect(callOutcome(error, undefined, runtime.isWireError)).toBe(expected);
  });
}

const decodedStatuses = [
  ['00', Code.Internal, true],
  ['013', Code.Internal, false],
  ['13x', Code.Internal, false],
  ['13.1', Code.Internal, false],
  ['16', Code.Unauthenticated, false],
  ['17', Code.Internal, true],
  ['-1', Code.Internal, true],
  [' 1', Code.Canceled, false],
  ['1 ', Code.Canceled, false],
  ['', Code.Internal, true],
  ['99', Code.Internal, true],
  ['nope', Code.Internal, true],
  ['13', Code.Internal, false],
  ['+13', Code.Internal, false],
] as const;

it.each(decodedStatuses)(
  'agrees with real Connect decoding grpc-status %j',
  async (status, code, invalid) => {
    const runtime = await loadConnectModule();
    const metadata = new Headers({ 'grpc-status': status, 'grpc-message': 'same message' });
    const error = findTrailerError(metadata);
    expect(error?.code).toBe(code);
    if (error === undefined) throw new Error('Expected a decoded status error');
    expect(runtime.isWireError(error)).toBe(true);
    const rejectedByDecoder =
      error.rawMessage === `invalid grpc-status: ${metadata.get('grpc-status')}`;
    expect(rejectedByDecoder).toBe(invalid);
    const decodedOutcome = rejectedByDecoder
      ? 'failure'
      : rows.find(([value]) => value === error.code)![1];
    expect(callOutcome(error, undefined, runtime.isWireError)).toBe(decodedOutcome);
  },
);

it('decodes exact grpc-status zero as success without an error', () => {
  expect(findTrailerError(new Headers({ 'grpc-status': '0' }))).toBeUndefined();
});

it('prefers real status details over a garbage grpc-status header', async () => {
  const runtime = await loadConnectModule();
  const application = new ConnectError('application answer', Code.Internal);
  application.details.push({ type: 'example.Detail', value: new Uint8Array([8, 1]) });
  const metadata = setTrailerStatus(new Headers(), application);
  expect(metadata.has('grpc-status-details-bin')).toBe(true);
  metadata.set('grpc-status', 'garbage');
  const decoded = findTrailerError(metadata);
  expect(decoded).toBeInstanceOf(ConnectError);
  expect(decoded?.code).toBe(Code.Internal);
  expect(decoded?.rawMessage).toBe(application.rawMessage);
  expect(runtime.isWireError(decoded)).toBe(true);
  expect(callOutcome(decoded, undefined, runtime.isWireError)).toBe('success');
});

it('retains the HTTP fallback for unknown real Connect JSON error codes', () => {
  // The real JSON decoder erases an unknown code string and retains only the HTTP fallback.
  // With Internal as fallback this is indistinguishable from a valid wire Internal.
  const fallback = () => new ConnectError('HTTP 400', codeFromHttpStatus(400));
  const unknown = errorFromJson({ code: 'not_a_code', message: 'same' }, undefined, fallback());
  const valid = errorFromJson({ code: 'internal', message: 'same' }, undefined, fallback());
  expect({
    code: unknown.code,
    metadata: [...unknown.metadata],
    wire: unknown.isWireError,
    raw: unknown.rawMessage,
  }).toEqual({
    code: valid.code,
    metadata: [...valid.metadata],
    wire: valid.isWireError,
    raw: valid.rawMessage,
  });
});
