#!/usr/bin/env -S deno run --allow-read --allow-env --allow-net=127.0.0.1
// deno-lint-ignore-file no-console -- console output is the script's purpose (AI_GUIDELINES §11.6)
/**
 * Runnable public consumer for the local diagnostics connector (M98b).
 *
 * Generates a fresh session ID/key pair IN MEMORY (the trusted-launcher
 * role), composes a small explicitly instrumented application whose local
 * listener is owned by the RuntimePlugin, connects the native client,
 * reads the signed snapshot and events, revokes the connector, proves
 * further reads fail, and proves the application still answers normally.
 *
 * No credential is ever printed, written, or passed through the
 * environment. The launcher's environment handoff and its trust limits are
 * documented in the package README; this demo demonstrates the in-memory
 * path only. It is the real loopback consumer exercise for M98b — the
 * extension repository is separately maintained and NOT claimed tested by
 * this script.
 *
 * Usage:
 *   deno run --allow-read --allow-net=127.0.0.1 scripts/inspect-local-diagnostics.ts
 *
 * @module
 */

import { createApplication } from '../packages/kernel/src/index.ts';
import { RuntimePlugin } from '../packages/runtime/src/index.ts';
import {
  createDiagnosticsClient,
  DiagnosticsPlugin,
} from '../packages/diagnostics-plugin/src/index.ts';

/** The fixed demo route, also the label allowlist entry. */
const DEMO_ROUTE = '/items';

/**
 * Generates `length` random bytes from the Web Crypto source.
 *
 * @param length - Number of bytes
 * @returns The random bytes
 */
function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

/**
 * Encodes bytes as lowercase hex.
 *
 * @param bytes - The bytes to encode
 * @returns Lowercase hex
 */
function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Picks a random port in the dynamic range. A bind conflict fails the demo
 * closed — there is deliberately no scan or fallback.
 *
 * @returns A port number from 49152 to 65535
 */
function randomPort(): number {
  return 49152 + (crypto.getRandomValues(new Uint16Array(1))[0] % 16384);
}

const sessionId = hex(randomBytes(16));
const sessionKey = randomBytes(32);
const port = randomPort();

const diagnostics = DiagnosticsPlugin({
  enabled: true,
  port,
  sessionId,
  sessionKey,
});

const app = createApplication({
  plugins: [
    RuntimePlugin(),
    diagnostics,
    {
      name: 'catalog',
      version: '1.0.0',
      provides: ['catalog-items'],
      register(ctx) {
        ctx.services.register('catalog-items', { items: [] });
        ctx.router.get(DEMO_ROUTE, (_ctx) => _ctx.response.json({ items: [] }));
      },
    },
  ],
  diagnostics: {
    labels: {
      plugins: ['catalog'],
      capabilities: ['catalog-items'],
      routes: [DEMO_ROUTE],
    },
  },
});

await app.start(); // no public port: only the loopback diagnostics listener

const client = createDiagnosticsClient({
  endpoint: `http://127.0.0.1:${port}`,
  sessionId,
  sessionKey,
  subtle: crypto.subtle,
  fetch,
  timing: { setTimeout, clearTimeout },
});

const snapshot = await client.snapshot();
console.log(`paired and read snapshot: state=${snapshot.state} nodes=${snapshot.nodes.length}`);

await app.inject({ method: 'GET', url: DEMO_ROUTE });
const batch = await client.read(0, 8);
console.log(
  `read ${batch.events.length} event(s); first stage: ${batch.events[0]?.stage ?? 'n/a'}`,
);

// End the session: authorization is disabled and the listener closes, but
// the application keeps serving.
await diagnostics.revoke();

let revokedReadFailed = false;
try {
  await client.read(0, 8);
} catch {
  revokedReadFailed = true;
}
console.log(`post-revoke read refused: ${revokedReadFailed}`);

const after = await app.inject({ method: 'GET', url: DEMO_ROUTE });
console.log(`application still serves: GET ${DEMO_ROUTE} -> ${after.statusCode}`);

client.close();
await app.stop();
