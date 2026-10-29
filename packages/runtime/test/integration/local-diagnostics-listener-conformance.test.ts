import { describe, expect, it } from 'vitest';
import type { ILocalDiagnosticsListenerFactory, IRequest } from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';
import { createApplication } from '../../../kernel/src/index.ts';
import { RuntimePlugin } from '../../src/index.ts';
import { PARSER_REFUSAL_BYTES } from '../../src/diagnostics/node-local-diagnostics-listener.ts';
import { unusedPort } from '../../../../test/node-helpers.ts';
import { diagnosticsResponse } from '../fixtures/diagnostics-response.ts';
import { exchangeDiagnosticsWire } from '../fixtures/diagnostics-wire.ts';

type Outcome = 'protocol-refusal' | 'transport-refusal' | 'served';

interface ConformanceRow {
  name: string;
  request(port: number): string;
  deno: Outcome;
  node: Outcome;
}

// Expectations come from plan §1a, §3.2–§3.3 and §3.14. They await an outside-sandbox
// run on both runtimes; a discrepancy is investigated, never copied into this table.
const rows: readonly ConformanceRow[] = [
  {
    name: 'canonical request',
    request: (p) => `GET /v1/status HTTP/1.1\r\nHost: 127.0.0.1:${p}\r\nConnection: close\r\n\r\n`,
    deno: 'served',
    node: 'served',
  },
  {
    name: 'Expect: 100-continue',
    request: (p) =>
      `GET /v1/status HTTP/1.1\r\nHost: 127.0.0.1:${p}\r\nExpect: 100-continue\r\nConnection: close\r\n\r\n`,
    deno: 'served',
    node: 'served',
  },
  {
    name: 'Expect: CANARY-token',
    request: (p) =>
      `GET /v1/status HTTP/1.1\r\nHost: 127.0.0.1:${p}\r\nExpect: CANARY-token\r\nConnection: close\r\n\r\n`,
    deno: 'served',
    node: 'served',
  },
  {
    name: 'missing Host',
    request: () => 'GET /v1/status HTTP/1.1\r\nConnection: close\r\n\r\n',
    deno: 'protocol-refusal',
    node: 'protocol-refusal',
  },
  {
    name: 'invalid Host',
    request: () =>
      'GET /v1/status HTTP/1.1\r\nHost: evil.com/../CANARY\r\nConnection: close\r\n\r\n',
    deno: 'protocol-refusal',
    node: 'protocol-refusal',
  },
  {
    name: 'non-loopback Host',
    request: () => 'GET /v1/status HTTP/1.1\r\nHost: evil.com\r\nConnection: close\r\n\r\n',
    deno: 'protocol-refusal',
    node: 'protocol-refusal',
  },
  {
    name: 'two Host lines',
    request: (p) =>
      `GET /v1/status HTTP/1.1\r\nHost: 127.0.0.1:${p}\r\nHost: evil.com\r\nConnection: close\r\n\r\n`,
    deno: 'transport-refusal',
    node: 'protocol-refusal',
  },
  {
    name: 'two X-Setu-Session lines',
    request: (p) =>
      `GET /v1/status HTTP/1.1\r\nHost: 127.0.0.1:${p}\r\nX-Setu-Session: a\r\nX-Setu-Session: CANARY\r\nConnection: close\r\n\r\n`,
    deno: 'protocol-refusal',
    node: 'protocol-refusal',
  },
  {
    name: 'garbage request line',
    request: () => 'CANARY garbage\r\n\r\n',
    deno: 'transport-refusal',
    node: 'transport-refusal',
  },
  {
    name: 'Transfer-Encoding with Content-Length',
    request: (p) =>
      `GET /v1/status HTTP/1.1\r\nHost: 127.0.0.1:${p}\r\nTransfer-Encoding: chunked\r\nContent-Length: 0\r\nConnection: close\r\n\r\n0\r\n\r\n`,
    deno: 'transport-refusal',
    node: 'transport-refusal',
  },
  {
    name: 'two zero Content-Length lines',
    request: (p) =>
      `GET /v1/status HTTP/1.1\r\nHost: 127.0.0.1:${p}\r\nContent-Length: 0\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
    deno: 'protocol-refusal',
    node: 'transport-refusal',
  },
  {
    name: 'absolute-form target',
    request: (p) =>
      `GET http://evil.com/v1/status HTTP/1.1\r\nHost: 127.0.0.1:${p}\r\nConnection: close\r\n\r\n`,
    deno: 'protocol-refusal',
    node: 'protocol-refusal',
  },
  {
    name: '20 KB header',
    request: (p) =>
      `GET /v1/status HTTP/1.1\r\nHost: 127.0.0.1:${p}\r\nX-Canary: ${'CANARY'.padEnd(20_000, 'x')}\r\nConnection: close\r\n\r\n`,
    deno: 'protocol-refusal',
    node: 'transport-refusal',
  },
  {
    name: '9 KB header above protocol budget',
    request: (p) =>
      `GET /v1/status HTTP/1.1\r\nHost: 127.0.0.1:${p}\r\nX-Canary: ${'CANARY'.padEnd(9_000, 'x')}\r\nConnection: close\r\n\r\n`,
    deno: 'protocol-refusal',
    node: 'protocol-refusal',
  },
  ...['/v1/./status', '/x/../v1/status', '/v1\\status'].map((target): ConformanceRow => ({
    name: `target alias ${target}`,
    request: (p) => `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${p}\r\nConnection: close\r\n\r\n`,
    deno: 'protocol-refusal',
    node: 'protocol-refusal',
  })),
];

describe('Local diagnostics transport conformance — plan §1a', () => {
  for (const row of rows) {
    it(row.name, async () => {
      const port = await unusedPort();
      const app = createApplication({ plugins: [RuntimePlugin()] });
      await app.start();
      const factory = app.services.get<ILocalDiagnosticsListenerFactory>(
        CAPABILITIES.LOCAL_DIAGNOSTICS_LISTENER,
      );
      const seen: IRequest[] = [];
      const listener = await factory.listen({
        port,
        onListen() {},
        handler(request) {
          seen.push(request);
          // This deliberately small protocol double enforces the connector's
          // authority, canonical target and 8 KiB parsed-header budget.
          const size = [...request.headers].reduce(
            (sum, [name, value]) => sum + new TextEncoder().encode(name + value).length,
            0,
          );
          const refused =
            request.headers.get('host') !== `127.0.0.1:${port}` ||
            request.url !== `http://127.0.0.1:${port}/v1/status` ||
            size > 8 * 1024;
          return diagnosticsResponse({
            streaming: false,
            status: refused ? 400 : 200,
            headers: new Headers({
              'content-type': 'application/json',
              'cache-control': 'no-store',
              'x-content-type-options': 'nosniff',
            }),
            body: refused ? '{"version":1,"error":"invalid-request"}' : 'served',
          });
        },
      });
      try {
        const response = await exchangeDiagnosticsWire(port, row.request(port));
        const runtime = 'Deno' in globalThis ? 'deno' : 'node';
        const expected = row[runtime];
        const measured =
          response.status === 200
            ? 'served'
            : response.status === 400 && response.body === ''
              ? 'transport-refusal'
              : response.status === 400 &&
                  response.body === '{"version":1,"error":"invalid-request"}'
                ? 'protocol-refusal'
                : 'unexpected-response';
        expect(measured, `Conformance discrepancy on ${runtime}: ${row.name}`).toBe(expected);
        expect(response.raw).not.toContain('CANARY');
        expect(response.raw).not.toContain('100 Continue');
        expect(response.raw).not.toContain('417');
        if (expected === 'served') {
          expect(response.status).toBe(200);
          expect(response.body).toBe('served');
          expect(seen).toHaveLength(1);
        } else if (expected === 'protocol-refusal') {
          expect(response.status).toBe(400);
          expect(response.body).toBe('{"version":1,"error":"invalid-request"}');
          expect(response.headers.get('content-type')).toBe('application/json');
          expect(response.headers.get('cache-control')).toBe('no-store');
          expect(response.headers.get('x-content-type-options')).toBe('nosniff');
        } else {
          expect(response.status).toBe(400);
          expect(response.body).toBe('');
          expect(response.headers.get('content-length')).toBe('0');
          expect(seen).toHaveLength(0);
          if (runtime === 'node') expect(response.raw).toBe(PARSER_REFUSAL_BYTES);
        }
      } finally {
        await listener.close();
        await app.stop();
      }
    });
  }
});
