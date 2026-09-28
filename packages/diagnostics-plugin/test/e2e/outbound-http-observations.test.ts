/**
 * End-to-end canary for outbound HTTP attempt observations (M98n): a REAL
 * loopback HTTP upstream, the REAL SDK client over an observed fetch, the
 * REAL kernel application with the helper's registration plugin, the
 * runtime-owned listener, and the signed native client.
 *
 * Canaries are planted in everything minimization must never reach — the
 * URL's userinfo, path, query and fragment, request headers and body,
 * response headers and body, and a rejection's message — and asserted
 * absent from the source snapshot, the RAW signed wire bytes and the client
 * DTO. The approved counters are asserted PRESENT alongside, so recording
 * nothing cannot pass. The §3.2 composition is also driven with and without
 * the `devtool` parameter (audit row O13).
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type { IOutboundHttpDiagnosticsSource, IPlugin } from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';
import type { KernelDiagnosticsOptions } from '@setu-ts/kernel';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { createClient, createObservedFetch } from '@setu-ts/sdk';

import { createDiagnosticsClient, DiagnosticsPlugin } from '../../src/index.ts';
import { TEST_KEY_BYTES, TEST_SESSION_ID } from '../fixtures/helpers.ts';

const CANARY = 'canary-SYNTHETIC';

function capturingFetch(frames: string[]): typeof fetch {
  return async (input, init) => {
    const response = await fetch(input, init);
    frames.push(await response.clone().text());
    return response;
  };
}

function freePort(): number {
  const probe = Deno.listen({ port: 0, hostname: '127.0.0.1' });
  const port = (probe.addr as Deno.NetAddr).port;
  probe.close();
  return port;
}

/** A loopback upstream: `/ok` 200, `/missing` 404, `/boom` 503, `/hang` never answers. */
function startUpstream() {
  const hangs: (() => void)[] = [];
  const server = Deno.serve({ port: 0, hostname: '127.0.0.1', onListen() {} }, (request) => {
    const path = new URL(request.url).pathname;
    if (path.endsWith('/hang')) {
      return new Promise<Response>((resolve) => hangs.push(() => resolve(new Response('late'))));
    }
    const status = path.endsWith('/missing') ? 404 : path.endsWith('/boom') ? 503 : 200;
    return new Response(`${CANARY}-response-body`, {
      status,
      headers: { 'set-cookie': `session=${CANARY}`, 'x-secret': CANARY },
    });
  });
  const port = (server.addr as Deno.NetAddr).port;
  return {
    base: `http://127.0.0.1:${port}`,
    releaseHangs: () => hangs.splice(0).forEach((release) => release()),
    close: async () => {
      await server.shutdown();
    },
  };
}

describe('Outbound HTTP observations e2e (M98n canary)', () => {
  it('serves approved counters end to end while every canary stays absent', async () => {
    const upstream = startUpstream();
    const connectorPort = freePort();
    const observed = createObservedFetch({ alias: 'payments-api' });
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        DiagnosticsPlugin({
          enabled: true,
          port: connectorPort,
          sessionId: TEST_SESSION_ID,
          sessionKey: TEST_KEY_BYTES,
        }),
        observed.plugin,
      ],
      diagnostics: {},
    });
    await app.start({ port: freePort(), hostname: '127.0.0.1' });
    try {
      const sdk = createClient({ baseUrl: upstream.base, fetch: observed.fetch });
      await sdk.request({
        method: 'POST',
        path: `orders/${CANARY}?token=${CANARY}`,
        headers: { Authorization: `Bearer ${CANARY}`, Cookie: `sid=${CANARY}` },
        json: { secret: CANARY },
      });
      await expect(sdk.request({ method: 'GET', path: 'missing' })).rejects.toThrow();
      // Direct call with userinfo and a fragment in the URL.
      const withUserinfo = upstream.base.replace('http://', `http://user:${CANARY}@`);
      const direct = await observed.fetch(`${withUserinfo}/boom#${CANARY}`).catch(() => null);
      await direct?.text();
      // A refused connection: a rejection whose message quotes the address.
      await expect(observed.fetch(`http://127.0.0.1:${freePort()}/${CANARY}`)).rejects.toThrow();
      // A hung call stays in flight.
      const hung = observed.fetch(`${upstream.base}/hang`);

      const source = app.services.getAll<IOutboundHttpDiagnosticsSource>(
        CAPABILITIES.OUTBOUND_HTTP_DIAGNOSTICS,
      )[0]!;
      expect(JSON.stringify(source.snapshot())).not.toContain(CANARY);

      const frames: string[] = [];
      const client = createDiagnosticsClient({
        endpoint: `http://127.0.0.1:${connectorPort}`,
        sessionId: TEST_SESSION_ID,
        sessionKey: TEST_KEY_BYTES,
        subtle: crypto.subtle,
        fetch: capturingFetch(frames),
        timing: { setTimeout, clearTimeout },
      });
      const response = await client.outboundHttp();
      client.close();

      // --- Approved counters survive (positive control) ---------------
      expect(response.state).toEqual('ready');
      expect(response.sources.length).toBe(1);
      const snapshot = response.sources[0]!.snapshot;
      expect(snapshot.alias).toEqual('payments-api');
      expect(snapshot.coverage).toEqual('owned-instance');
      const record = snapshot.records[0]!;
      // POST ok, GET 404, direct 503 (or a userinfo refusal), refused, hung.
      expect(record.started).toBe(5);
      expect(record.count).toBe(4);
      expect(record.responses + record.failures).toBe(4);
      expect(record.failures).toBeGreaterThanOrEqual(1);
      expect(record.lastDurationMs).not.toBeNull();

      // --- Canaries absent everywhere ---------------------------------
      expect(frames.length).toBeGreaterThanOrEqual(2);
      for (const frame of frames) {
        expect(frame).not.toContain(CANARY);
      }
      expect(JSON.stringify(response)).not.toContain(CANARY);

      upstream.releaseHangs();
      await (await hung).text();
    } finally {
      await app.stop();
      await upstream.close();
    }
  });

  it('builds no helper, plugin or source without the devtool parameter (O13)', async () => {
    const upstream = startUpstream();
    function createApp(
      _env?: Readonly<Record<string, unknown>>,
      devtool?: { plugins?: readonly IPlugin[]; diagnostics?: KernelDiagnosticsOptions },
    ) {
      const observed = devtool ? createObservedFetch({ alias: 'payments-api' }) : undefined;
      const payments = createClient({
        baseUrl: upstream.base,
        ...(observed ? { fetch: observed.fetch } : {}),
      });
      const app = createApplication({
        plugins: [
          RuntimePlugin(),
          ...(observed ? [observed.plugin] : []),
          ...(devtool?.plugins ?? []),
        ],
        ...(devtool?.diagnostics !== undefined ? { diagnostics: devtool.diagnostics } : {}),
      });
      return { app, payments };
    }
    try {
      const production = createApp(undefined);
      await production.app.start();
      await production.payments.request({ method: 'GET', path: 'ok' });
      expect(production.app.services.has(CAPABILITIES.OUTBOUND_HTTP_DIAGNOSTICS)).toBe(false);
      await production.app.stop();

      const connectorPort = freePort();
      const dev = createApp(undefined, {
        plugins: [
          DiagnosticsPlugin({
            enabled: true,
            port: connectorPort,
            sessionId: TEST_SESSION_ID,
            sessionKey: TEST_KEY_BYTES,
          }),
        ],
        diagnostics: {},
      });
      await dev.app.start();
      await dev.payments.request({ method: 'GET', path: 'ok' });
      const client = createDiagnosticsClient({
        endpoint: `http://127.0.0.1:${connectorPort}`,
        sessionId: TEST_SESSION_ID,
        sessionKey: TEST_KEY_BYTES,
        subtle: crypto.subtle,
        fetch,
        timing: { setTimeout, clearTimeout },
      });
      const response = await client.outboundHttp();
      client.close();
      expect(response.sources.length).toBe(1);
      expect(response.sources[0]!.snapshot.records[0]).toMatchObject({
        started: 1,
        count: 1,
        responses: 1,
        lastStatusClass: '2xx',
      });
      await dev.app.stop();
      // Closed by the plugin's own close hook.
    } finally {
      await upstream.close();
    }
  });
});
