/**
 * End-to-end canary for distributed tracing observations (M98g): a REAL Deno
 * socket, the REAL kernel application, the REAL runtime-owned listener, the
 * REAL OTel provider driving the diagnostic span processor, and the signed
 * native client — across TWO independently paired applications.
 *
 * Canaries are planted in a raw span NAME (an unapproved dynamic path) and
 * in an attribute of an approved span. The test asserts every canary is
 * absent at each layer an observation crosses — the source batch, the RAW
 * signed wire bytes captured below the client, and the client DTO — while
 * the useful trace/span identifiers, aliases and relationships remain
 * present, so suppressing every record cannot make it pass. It repeats the
 * M98b refusals for the traces target over a raw socket, and proves two
 * applications are correlatable by EQUAL trace ids alone, with no
 * fabricated edge and no cross-instance authority.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { CAPABILITIES, TELEMETRY_CONTEXT_OPAQUE } from '@setu-ts/common';
import type { ITelemetryService, TelemetryContext } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { TelemetryPlugin } from '@setu-ts/telemetry-plugin';

import { createDiagnosticsClient, DiagnosticsPlugin } from '../../src/index.ts';
import type { IDiagnosticsClient } from '../../src/index.ts';
import { TEST_KEY_BYTES, TEST_SESSION_ID } from '../fixtures/helpers.ts';

const NAME_CANARY = 'POST /secret-path-CANARY-0001';
const ATTRIBUTE_CANARY = 'attribute-canary-CANARY-0002';
const APPROVED_NAME = 'orders.create-CANARY-0003';

/** A fetch that records every raw response body the client receives. */
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

interface App {
  app: Awaited<ReturnType<typeof createApplication>>;
  client: IDiagnosticsClient;
  telemetry: ITelemetryService;
  frames: string[];
  connectorPort: number;
}

async function startTracingApplication(serviceAlias: string): Promise<App> {
  const connectorPort = freePort();
  const frames: string[] = [];
  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      DiagnosticsPlugin({
        enabled: true,
        port: connectorPort,
        sessionId: TEST_SESSION_ID,
        sessionKey: TEST_KEY_BYTES,
      }),
      TelemetryPlugin({
        serviceName: serviceAlias,
        exporter: 'console',
        middleware: false,
        diagnostics: {
          enabled: true,
          serviceAlias,
          operations: { [APPROVED_NAME]: 'create-order' },
        },
      }),
    ],
    diagnostics: {},
  });
  await app.start();
  const client = createDiagnosticsClient({
    endpoint: `http://127.0.0.1:${connectorPort}`,
    sessionId: TEST_SESSION_ID,
    sessionKey: TEST_KEY_BYTES,
    subtle: crypto.subtle,
    fetch: capturingFetch(frames),
    timing: { setTimeout, clearTimeout },
  });
  const telemetry = app.services.get<ITelemetryService>(CAPABILITIES.TELEMETRY);
  return { app, client, telemetry, frames, connectorPort };
}

describe('Distributed tracing observations (M98g) — end to end', () => {
  it('correlates two independently paired apps by trace id, with no fabricated edge', async () => {
    const first = await startTracingApplication('svc-a');
    const second = await startTracingApplication('svc-b');
    try {
      // A root span in the FIRST application completes and is retained.
      await first.telemetry.withSpan(APPROVED_NAME, async () => {});
      const firstBatch = await first.client.traces(0);
      expect(firstBatch.state).toBe('ready');
      expect(firstBatch.coverage).toBe('completed-sampled-spans');
      expect(firstBatch.records.length).toBe(1);
      const root = firstBatch.records[0]!;
      expect(root.operationAlias).toBe('create-order');
      expect(root.parentVisibility).toBe('root');

      // The SECOND application creates a span parented by the FIRST app's
      // identifiers — the shape of a propagated traceparent hop. Both apps
      // now hold records sharing ONE trace id; neither can see the other's
      // instance, and the second's parent is unobserved LOCALLY.
      await second.telemetry.withSpan(
        APPROVED_NAME,
        async () => {},
        {
          kind: 'server',
          parentContext: {
            _opaque: TELEMETRY_CONTEXT_OPAQUE,
            traceId: root.traceId,
            spanId: root.spanId,
            traceFlags: '01',
          } as TelemetryContext,
        },
      );
      const secondBatch = await second.client.traces(0);
      expect(secondBatch.records.length).toBe(1);
      const hop = secondBatch.records[0]!;
      // Correlation is by EQUAL TRACE IDS, nothing more.
      expect(hop.traceId).toBe(root.traceId);
      expect(hop.spanId).not.toBe(root.spanId);
      // No fabricated edge: the second process cannot observe the parent.
      expect(hop.parentVisibility).toBe('remote-or-unobserved');
      expect(hop.parentSpanId).toBe(root.spanId);
      // Instance binding: each client's batch names ITS OWN application.
      expect(firstBatch.instanceId).not.toBe(secondBatch.instanceId);

      // Canaries: the unapproved raw name is dropped; the approved span's
      // attribute never enters any layer. `withSpan` requires the async
      // callback shape even when the body has nothing to await.
      await first.telemetry.withSpan(
        APPROVED_NAME,
        // deno-lint-ignore require-await
        async (span) => {
          span.setAttribute('order.url', ATTRIBUTE_CANARY);
        },
      );
      await first.telemetry.withSpan(NAME_CANARY, () => Promise.resolve());
      const after = await first.client.traces(0);
      expect(after.records.length).toBe(2);
      const serialized = JSON.stringify({ batch: after, wire: first.frames });
      expect(serialized.includes('CANARY')).toBe(false);
      expect(serialized.includes('secret-path')).toBe(false);
      // The approved relationships remain: suppressing every record cannot
      // make this test pass.
      expect(after.records[1]!.parentVisibility).toBe('root');
      expect(after.droppedSpans).toBe(1);
    } finally {
      first.client.close();
      second.client.close();
      await first.app.stop();
      await second.app.stop();
    }
  });

  it('refuses unsigned and non-GET traces requests over the raw socket', async () => {
    const { app, client, connectorPort } = await startTracingApplication('svc-refused');
    try {
      // Pairing first: a healthy read proves the connector is up.
      await client.traces(0);
      // A traces request with malformed headers is refused invalid-request.
      const unsigned = await fetch(
        `http://127.0.0.1:${connectorPort}/v1/traces?after=0&limit=1`,
        { headers: { host: `127.0.0.1:${connectorPort}` } },
      );
      expect(unsigned.status).toBe(400);
      const body = (await unsigned.json()) as { error: string };
      expect(body.error).toBe('invalid-request');
      // A WELL-FORMED session id that is not the paired one is unauthorized.
      const foreign = await fetch(
        `http://127.0.0.1:${connectorPort}/v1/traces?after=0&limit=1`,
        {
          headers: {
            host: `127.0.0.1:${connectorPort}`,
            'x-setu-session': 'b'.repeat(32),
            'x-setu-sequence': '2',
            'x-setu-instance': '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
            'x-setu-mac': 'f'.repeat(64),
          },
        },
      );
      expect(foreign.status).toBe(401);
      expect(((await foreign.json()) as { error: string }).error).toBe('unauthorized');
      // Non-GET never reaches the handler slots.
      const post = await fetch(
        `http://127.0.0.1:${connectorPort}/v1/traces?after=0&limit=1`,
        { method: 'POST' },
      );
      expect(post.status).toBe(400);
    } finally {
      client.close();
      await app.stop();
    }
  });
});
