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
    expect(callOutcome(error, undefined, () => false)).toBeUndefined();
  }
});

it('does not attribute local serialization or write-limit faults to the instance', async () => {
  const runtime = await loadConnectModule();
  const serialization = ConnectError.from(new Error('cannot serialize request'), Code.Internal);
  const writeLimit = new ConnectError(
    'message size 10 is larger than configured writeMaxBytes 1',
    Code.ResourceExhausted,
  );
  for (const error of [
    serialization,
    writeLimit,
    new ConnectError('local setup failed', Code.Unavailable),
  ]) {
    expect(error.metadata.keys().next().done).toBe(true);
    expect(callOutcome(error, undefined, runtime.isWireError)).toBeUndefined();
  }
});

it('requires non-wire response headers, system cause evidence, deadline or peer cancellation', async () => {
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
  expect(callOutcome(cause, undefined, runtime.isWireError)).toBeUndefined();
  expect(
    callOutcome(Object.assign(new Error(), { cause: null }), undefined, runtime.isWireError),
  ).toBeUndefined();
});
