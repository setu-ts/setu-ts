/**
 * End-to-end canary for queue observations (M98f): a REAL Deno socket, the
 * REAL kernel application, the REAL runtime-owned listener, two REAL queue
 * plugin instances (memory, and SQS over an in-memory transport) processing
 * real jobs, the connector's merge, and the signed native client.
 *
 * Canaries are planted in a job payload, a job header, the raw job id, the
 * SQS receipt handle (the claim token), the SQS credentials and queue URL,
 * and a processor's thrown error. The test asserts every canary is absent at
 * each layer an observation crosses — the source batch, the RAW signed wire
 * bytes captured below the client, and the client DTO — while the useful
 * attempts, settlements and depths remain present, so suppressing every
 * record cannot make it pass. It then repeats the M98b refusals for the
 * queues target over a raw socket.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { CAPABILITIES } from '@setu-ts/common';
import type { IQueue, IQueueDiagnosticsSource } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { QueuePlugin } from '@setu-ts/queue-plugin';
import type { ISqsTransport, SqsReceivedMessage } from '@setu-ts/queue-plugin';

import { createDiagnosticsClient, DiagnosticsPlugin } from '../../src/index.ts';
import { requestMacFields, signFields } from '../../src/security/authentication.ts';
import { importTestKey, TEST_KEY_BYTES, TEST_SESSION_ID } from '../fixtures/helpers.ts';

const PAYLOAD_CANARY = 'payload-canary-SYNTHETIC-0001';
const HEADER_CANARY = 'header-canary-SYNTHETIC-0002';
const ERROR_CANARY = 'error-canary-SYNTHETIC-0003';
const RECEIPT_CANARY = 'receipt-canary-SYNTHETIC-0004';
const CREDENTIAL_CANARY = 'credential-canary-SYNTHETIC-0005';
const QUEUE_URL = 'https://sqs.local/000000000000/queue-url-canary-SYNTHETIC-0006';
const POLL_MS = 5;

/** An in-memory SQS transport whose receipt handles carry a canary. */
function canaryTransport(): ISqsTransport & { deletes: number } {
  const messages: { handle: string; body: string; visibleAt: number; received: number }[] = [];
  let handles = 0;
  const transport = {
    deletes: 0,
    send(_queueUrl: string, body: string): Promise<void> {
      handles += 1;
      messages.push({ handle: `${RECEIPT_CANARY}-${handles}`, body, visibleAt: 0, received: 0 });
      return Promise.resolve();
    },
    receive(_queueUrl: string, max: number, visibility: number) {
      const now = performance.now();
      const out: SqsReceivedMessage[] = [];
      for (const message of messages) {
        if (out.length < max && message.visibleAt <= now) {
          message.visibleAt = now + visibility * 1000;
          message.received += 1;
          out.push({
            receiptHandle: message.handle,
            body: message.body,
            approximateReceiveCount: String(message.received),
          });
        }
      }
      return Promise.resolve(out);
    },
    delete(_queueUrl: string, handle: string): Promise<void> {
      transport.deletes += 1;
      const index = messages.findIndex((m) => m.handle === handle);
      if (index >= 0) messages.splice(index, 1);
      return Promise.resolve();
    },
    changeVisibility(): Promise<void> {
      return Promise.resolve();
    },
    close(): Promise<void> {
      return Promise.resolve();
    },
  };
  return transport;
}

/** A fetch that records every raw response body the client receives. */
function capturingFetch(frames: string[]): typeof fetch {
  return async (input, init) => {
    const response = await fetch(input, init);
    frames.push(await response.clone().text());
    return response;
  };
}

/** Waits for `predicate`, or fails the test rather than hanging forever. */
async function until(predicate: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function freePort(): number {
  const probe = Deno.listen({ port: 0, hostname: '127.0.0.1' });
  const port = (probe.addr as Deno.NetAddr).port;
  probe.close();
  return port;
}

async function startQueueApplication() {
  const connectorPort = freePort();
  const delivered: string[] = [];
  const transport = canaryTransport();
  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      DiagnosticsPlugin({
        enabled: true,
        port: connectorPort,
        sessionId: TEST_SESSION_ID,
        sessionKey: TEST_KEY_BYTES,
      }),
      QueuePlugin({
        adapter: 'memory',
        pollIntervalMs: POLL_MS,
        processors: [
          { name: 'email.send', processor: () => void delivered.push('email') },
          {
            name: 'image.resize',
            processor: () => {
              delivered.push('image');
              throw new Error(ERROR_CANARY);
            },
          },
        ],
        diagnostics: {
          enabled: true,
          instanceAlias: 'web-worker',
          queues: { 'email.send': 'emails', 'image.resize': 'images' },
          depths: { intervalMs: 1_000, timeoutMs: 500, concurrency: 2 },
        },
      }),
      QueuePlugin({
        adapter: 'sqs',
        name: 'cloud',
        pollIntervalMs: POLL_MS,
        sqs: {
          queues: { 'report.build': QUEUE_URL },
          client: transport,
          credentials: { accessKeyId: CREDENTIAL_CANARY, secretAccessKey: CREDENTIAL_CANARY },
        },
        processors: [{ name: 'report.build', processor: () => void delivered.push('report') }],
        diagnostics: {
          enabled: true,
          instanceAlias: 'cloud-worker',
          queues: { 'report.build': 'reports' },
        },
      }),
    ],
    diagnostics: {},
  });
  await app.start();
  return { app, connectorPort, delivered, transport };
}

describe('Queue observations e2e (M98f canary)', () => {
  it('minimizes queue observations end to end: canaries absent, attempts and depths present', async () => {
    const { app, connectorPort, delivered, transport } = await startQueueApplication();
    try {
      const memory = app.services.get<IQueue>('queue');
      const cloud = app.services.get<IQueue>('queue.cloud');
      const ids = [
        await memory.add('email.send', { secret: PAYLOAD_CANARY }, {
          headers: { traceparent: HEADER_CANARY },
        }),
        await memory.add('image.resize', { secret: PAYLOAD_CANARY }, { maxAttempts: 1 }),
        await memory.add('image.resize', { secret: PAYLOAD_CANARY }, { maxAttempts: 2 }),
        await cloud.add('report.build', { secret: PAYLOAD_CANARY }),
      ];
      await until(() => delivered.length >= 4 && transport.deletes === 1, 'the deliveries');

      const frames: string[] = [];
      const client = createDiagnosticsClient({
        endpoint: `http://127.0.0.1:${connectorPort}`,
        sessionId: TEST_SESSION_ID,
        sessionKey: TEST_KEY_BYTES,
        subtle: crypto.subtle,
        fetch: capturingFetch(frames),
        timing: { setTimeout, clearTimeout },
      });
      let batch = await client.queues(0);
      // Paced under the connector's 20/s session budget: a tighter loop would
      // be refused `rate-limited`, which is the budget working.
      for (let attempt = 0; attempt < 20 && batch.events.length < 4; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        batch = await client.queues(0);
      }
      const sources = app.services.getAll<IQueueDiagnosticsSource>(
        CAPABILITIES.QUEUE_DIAGNOSTICS,
      );
      const sourceBatches = sources.map((source) => source.read(0));
      client.close();

      // Useful, positive observations survive minimization.
      expect(batch.state).toBe('ready');
      expect(batch.sources.map((s) => [s.sourceId, s.instanceAlias, s.state])).toEqual([
        ['q1', 'web-worker', 'ready'],
        ['q2', 'cloud-worker', 'ready'],
      ]);
      const summary = batch.events.map((e) => [e.sourceId, e.queueAlias, e.outcome, e.settlement])
        .sort();
      expect(summary).toEqual([
        ['q1', 'emails', 'completed', 'acknowledged'],
        ['q1', 'images', 'retryable-error', 'requeued'],
        ['q1', 'images', 'terminal-error', 'dead-lettered'],
        ['q2', 'reports', 'completed', 'unknown'],
      ].sort());
      expect(batch.depths.map((d) => [d.sourceId, d.queueAlias, d.scope])).toEqual([
        ['q1', 'emails', 'process-local'],
        ['q1', 'images', 'process-local'],
      ]);
      expect(batch.sources[1].depthCoverage).toBe('disabled');

      // Every canary is absent at every layer: source, raw signed wire, DTO.
      const layers = {
        source: JSON.stringify(sourceBatches),
        wire: frames.join('\n'),
        client: JSON.stringify(batch),
      };
      const canaries = [
        PAYLOAD_CANARY,
        HEADER_CANARY,
        ERROR_CANARY,
        RECEIPT_CANARY,
        CREDENTIAL_CANARY,
        QUEUE_URL,
        'email.send',
        'image.resize',
        'report.build',
        'queue.cloud',
        ...ids,
      ];
      for (const [layer, text] of Object.entries(layers)) {
        for (const canary of canaries) {
          expect({ layer, leaked: text.includes(canary) }).toEqual({ layer, leaked: false });
        }
      }
      expect(frames.some((frame) => frame.includes('"jobAlias"'))).toBe(true);
    } finally {
      await app.stop();
    }
  });

  it('answers an unsupported queues batch when no queue plugin is present', async () => {
    const connectorPort = freePort();
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        DiagnosticsPlugin({
          enabled: true,
          port: connectorPort,
          sessionId: TEST_SESSION_ID,
          sessionKey: TEST_KEY_BYTES,
        }),
      ],
      diagnostics: {},
    });
    await app.start();
    try {
      const client = createDiagnosticsClient({
        endpoint: `http://127.0.0.1:${connectorPort}`,
        sessionId: TEST_SESSION_ID,
        sessionKey: TEST_KEY_BYTES,
        subtle: crypto.subtle,
        fetch,
        timing: { setTimeout, clearTimeout },
      });
      const batch = await client.queues(0);
      client.close();
      expect(batch.state).toBe('unsupported');
      expect(batch.sources).toEqual([]);
    } finally {
      await app.stop();
    }
  });
});

/** Sends one RAW request over a fresh TCP connection. */
async function rawRequest(port: number, raw: string): Promise<{ status: number; body: string }> {
  const connection = await Deno.connect({ port, hostname: '127.0.0.1' });
  await connection.write(new TextEncoder().encode(raw));
  const response = await connection.readable.getReader().read();
  await connection.close();
  const text = new TextDecoder().decode(response.value);
  const [head, ...rest] = text.split('\r\n\r\n');
  return { status: Number.parseInt(head.split('\r\n')[0].split(' ')[1], 10), body: rest.join('') };
}

describe('Queue observations e2e — M98b refusals for /v1/queues', () => {
  it('refuses unauthenticated, browser, mutating, cross-instance and replayed queue reads', async () => {
    const { app, connectorPort: port } = await startQueueApplication();
    try {
      const key = await importTestKey(crypto.subtle);
      const target = '/v1/queues?after=0&limit=1';
      const sign = (sequence: number, instance: string, path = target) =>
        signFields(
          crypto.subtle,
          key,
          requestMacFields(TEST_SESSION_ID, instance, String(sequence), `127.0.0.1:${port}`, path),
        );
      const request = (
        sequence: number,
        instance: string,
        mac: string,
        extra = '',
        method = 'GET',
        path = target,
      ) =>
        `${method} ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
        `X-Setu-Session: ${TEST_SESSION_ID}\r\nX-Setu-Sequence: ${sequence}\r\n` +
        `X-Setu-Instance: ${instance}\r\nX-Setu-Mac: ${mac}\r\n${extra}\r\n`;

      // Pair first, over the raw socket, to learn the bound instance.
      const statusMac = await signFields(
        crypto.subtle,
        key,
        requestMacFields(TEST_SESSION_ID, '', '1', `127.0.0.1:${port}`, '/v1/status'),
      );
      const paired = await rawRequest(
        port,
        `GET /v1/status HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
          `X-Setu-Session: ${TEST_SESSION_ID}\r\nX-Setu-Sequence: 1\r\nX-Setu-Mac: ${statusMac}\r\n\r\n`,
      );
      expect(paired.status).toBe(200);
      const instance = (JSON.parse(paired.body) as { instanceId: string }).instanceId;
      const otherInstance = '0'.repeat(8) + instance.slice(8);

      // Missing credentials, a browser Origin, and a write method.
      expect(
        (await rawRequest(port, `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`))
          .status,
      ).toBe(400);
      expect(
        (await rawRequest(port, request(2, instance, await sign(2, instance), 'Origin: null\r\n')))
          .status,
      ).toBe(400);
      expect(
        (await rawRequest(port, request(3, instance, await sign(3, instance), '', 'POST'))).status,
      ).toBe(400);
      // A wrong MAC, and a MAC honestly signed for another instance.
      expect((await rawRequest(port, request(4, instance, 'f'.repeat(64)))).status).toBe(401);
      expect(
        (await rawRequest(port, request(5, otherInstance, await sign(5, otherInstance)))).status,
      ).toBe(401);
      // An unsupported protocol version in the target.
      const v2 = '/v2/queues?after=0&limit=1';
      expect(
        (await rawRequest(port, request(6, instance, await sign(6, instance, v2), '', 'GET', v2)))
          .status,
      ).toBe(400);
      // An honest read is served; replaying its exact bytes is refused.
      const honest = request(7, instance, await sign(7, instance));
      const served = await rawRequest(port, honest);
      expect(served.status).toBe(200);
      expect((JSON.parse(served.body) as { state: string }).state).toBe('ready');
      expect((await rawRequest(port, honest)).status).toBe(401);
    } finally {
      await app.stop();
    }
  });
});
