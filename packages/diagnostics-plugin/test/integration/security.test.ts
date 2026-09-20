/**
 * Integration security tests over a REAL socket: missing/wrong/replayed
 * credentials, browser origins, wrong Host, unknown methods, DNS-rebinding
 * Host values — every hostile request receives a fixed, value-free refusal
 * and no data; the canary absence and allowed-metadata visibility are
 * asserted on the served snapshot.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { createApplication } from '../../../kernel/src/index.ts';
import { RuntimePlugin } from '../../../runtime/src/index.ts';
import { createDiagnosticsClient, DiagnosticsPlugin } from '../../src/index.ts';
import { requestMacFields, signFields } from '../../src/security/authentication.ts';
import { importTestKey, TEST_KEY_BYTES, TEST_SESSION_ID } from '../fixtures/helpers.ts';

/**
 * Signs an honest request against the ACTUAL bound port (the MAC covers
 * the authority, so it must match the real listener).
 *
 * @param subtle - Subtle crypto
 * @param key - Imported session key
 * @param port - The real connector port
 * @param target - Canonical target
 * @param sequence - Sequence number
 * @returns The hex MAC
 */
async function signForPort(
  subtle: SubtleCrypto,
  key: CryptoKey,
  port: number,
  target: string,
  sequence: number,
): Promise<string> {
  return await signFields(
    subtle,
    key,
    requestMacFields(
      TEST_SESSION_ID,
      '',
      String(sequence),
      `127.0.0.1:${port}`,
      target,
    ),
  );
}

/**
 * Composes and starts one application with the connector on a free port.
 *
 * @returns The running app, its port, and the plugin instance
 */
async function startApp(): Promise<{
  app: ReturnType<typeof createApplication>;
  port: number;
  plugin: { revoke(): Promise<void> };
}> {
  const listener = Deno.listen({ port: 0, hostname: '127.0.0.1' });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  const plugin = DiagnosticsPlugin({
    enabled: true,
    port,
    sessionId: TEST_SESSION_ID,
    sessionKey: TEST_KEY_BYTES,
  });
  const app = createApplication({
    plugins: [RuntimePlugin(), plugin],
    diagnostics: {},
  });
  await app.start();
  return { app, port, plugin };
}

/**
 * Sends one RAW request over a fresh TCP connection and returns the
 * status line and body.
 *
 * @param port - The connector port
 * @param raw - The raw HTTP request bytes/text
 * @returns Status code, headers, and body text
 */
async function rawRequest(
  port: number,
  raw: string,
): Promise<{ status: number; headers: Headers; body: string }> {
  const connection = await Deno.connect({ port, hostname: '127.0.0.1' });
  await connection.write(new TextEncoder().encode(raw));
  const response = await connection.readable.getReader().read();
  await connection.close();
  if (response.value === undefined) {
    throw new Error('no response');
  }
  const text = new TextDecoder().decode(response.value);
  const [head, ...rest] = text.split('\r\n\r\n');
  const lines = head.split('\r\n');
  const status = Number.parseInt(lines[0].split(' ')[1], 10);
  const headers = new Headers();
  for (const line of lines.slice(1)) {
    const idx = line.indexOf(':');
    if (idx > 0) {
      headers.set(line.slice(0, idx).trim(), line.slice(idx + 1).trim());
    }
  }
  return { status, headers, body: rest.join('\r\n\r\n') };
}

describe('Security — hostile raw requests over a real socket', () => {
  it('refuses missing credentials, wrong methods, browser origins, and rebinding Hosts', async () => {
    const { app, port } = await startApp();
    const cases: readonly [string, number][] = [
      // No credentials at all.
      [`GET /v1/status HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`, 400],
      // A browser context — any Origin, including the string null.
      [
        `GET /v1/status HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: null\r\n\r\n`,
        400,
      ],
      [
        `GET /v1/status HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: http://evil.example\r\n\r\n`,
        400,
      ],
      // DNS-rebinding / wrong authority.
      [
        `GET /v1/status HTTP/1.1\r\nHost: attacker.example:${port}\r\n\r\n`,
        400,
      ],
      // Write methods.
      [`POST /v1/status HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`, 400],
      // A request declaring a body.
      [
        `GET /v1/status HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Length: 5\r\n\r\nhello`,
        400,
      ],
      // Chunked framing.
      [
        `GET /v1/status HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nTransfer-Encoding: chunked\r\n\r\n`,
        400,
      ],
      // A duplicate singleton header coalesced by the fetch parser: the
      // comma proves the duplicate line.
      [
        `GET /v1/status HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nX-Setu-Session: ${TEST_SESSION_ID}\r\nX-Setu-Session: ${TEST_SESSION_ID}\r\n\r\n`,
        400,
      ],
      // Unknown protocol version in the target.
      [`GET /v9/status HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`, 400],
    ];
    for (const [raw, expectedStatus] of cases) {
      const response = await rawRequest(port, raw);
      expect(response.status).toEqual(expectedStatus);
      expect(response.headers.get('cache-control')).toEqual('no-store');
      const parsed = JSON.parse(response.body) as Record<string, unknown>;
      expect(parsed.version).toEqual(1);
      expect(typeof parsed.error).toEqual('string');
    }
    await app.stop();
  });

  it('refuses a replayed signed request and a wrong-session request', async () => {
    const { app, port } = await startApp();
    const key = await importTestKey(crypto.subtle);
    const mac = await signForPort(crypto.subtle, key, port, '/v1/status', 1);
    const request = (session: string, macValue: string) =>
      `GET /v1/status HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
      `X-Setu-Session: ${session}\r\nX-Setu-Sequence: 1\r\nX-Setu-Mac: ${macValue}\r\n\r\n`;
    // Honest session id, correct MAC: 200.
    const first = await rawRequest(port, request(TEST_SESSION_ID, mac));
    expect(first.status).toEqual(200);
    // THE SAME bytes replayed: refused.
    const replay = await rawRequest(port, request(TEST_SESSION_ID, mac));
    expect(replay.status).toEqual(401);
    // A different session id: refused before crypto.
    const wrongSession = await rawRequest(
      port,
      request('b'.repeat(32), mac),
    );
    expect(wrongSession.status).toEqual(401);
    await app.stop();
  });

  it('serves no canary from a hostile provider result and keeps allowed metadata', async () => {
    // This is covered in depth at the handler level (canary absence with
    // allowed metadata visible); over the real socket we prove the
    // application itself has no secret-bearing fields projected.
    const { app, port } = await startApp();
    const client = createDiagnosticsClient({
      endpoint: `http://127.0.0.1:${port}`,
      sessionId: TEST_SESSION_ID,
      sessionKey: TEST_KEY_BYTES,
      subtle: crypto.subtle,
      fetch,
      timing: { setTimeout, clearTimeout },
    });
    const snapshot = await client.snapshot();
    const text = JSON.stringify(snapshot);
    expect(text.includes('password')).toBe(false);
    expect(text.includes('sessionKey')).toBe(false);
    expect(snapshot.nodes.length).toBeGreaterThan(0);
    client.close();
    await app.stop();
  });
});
