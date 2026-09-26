/**
 * End-to-end canary for value-free configuration provenance (M98e): a REAL
 * Deno socket, the REAL kernel application, the REAL runtime-owned listener,
 * the connector, the ConfigPlugin's load-time provenance record, and the
 * signed native client over a real `loadConfig` → `ConfigPlugin({ instance })`
 * composition.
 *
 * Canaries are planted where the minimization seam must never reach: a
 * secret-shaped value in an UNAPPROVED key, a value-shaped string in the
 * approved file (and inside an expanded reference's resolution), and the raw
 * file path itself. The test asserts the useful approved provenance —
 * precedence displacement, file alias, expansion reference — survives at the
 * source snapshot, the RAW signed wire bytes, and the client DTO, while every
 * canary is absent at all three layers. This proves the seam minimizes, not
 * merely that a field is missing by luck.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { CAPABILITIES } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { createRuntimeServices, RuntimePlugin } from '@setu-ts/runtime';
import { ConfigPlugin, loadConfig } from '@setu-ts/config-plugin';

import { createDiagnosticsClient, DiagnosticsPlugin } from '../../src/index.ts';
import { TEST_KEY_BYTES, TEST_SESSION_ID } from '../fixtures/helpers.ts';

const CANARY_FILE_VALUE = 'canary-file-value-SYNTHETIC';
const CANARY_FILE_HOST = 'file-host-SYNTHETIC';
// The REAL fixture basename — a canary that names a file that does not exist
// would pass vacuously. (`txt`, not `env`: the dependency-drift gate's
// documented non-source extension list covers `txt`, so a tracked data
// fixture introduces no new extension decision.)
const RAW_FILE_NAME = 'canary.env.txt';
const UNAPPROVED_KEY = 'DB_PASSWORD';
const RAW_APPROVED_KEY = 'M98E_WS';

/** The absolute fixture path — cwd-independent, unlike a relative one. */
const CANARY_PATH = new URL('../fixtures/canary.env.txt', import.meta.url).pathname;

/** The provenance key/alias map the load and the plugin share. */
function diagnosticsKeys(): Record<string, string> {
  return { M98E_PORT: 'port', HOST: 'host', M98E_WS: 'ws' };
}

/** A fetch that records every raw response body the client receives. */
function capturingFetch(frames: string[]): typeof fetch {
  return async (input, init) => {
    const response = await fetch(input, init);
    frames.push(await response.clone().text());
    return response;
  };
}

interface Started {
  app: ReturnType<typeof createApplication>;
  connectorPort: number;
  instance: unknown;
}

/**
 * Starts a real application whose configuration is loaded ONCE through
 * `loadConfig` and handed to `ConfigPlugin({ instance })` — the composition
 * the milestone exists to serve.
 */
async function startConfigProvenanceApplication(): Promise<Started> {
  const probe = Deno.listen({ port: 0, hostname: '127.0.0.1' });
  const httpPort = (probe.addr as Deno.NetAddr).port;
  probe.close();
  const connectorProbe = Deno.listen({ port: 0, hostname: '127.0.0.1' });
  const connectorPort = (connectorProbe.addr as Deno.NetAddr).port;
  connectorProbe.close();

  // The environment half of the snapshot: M98E_PORT displaces the file's
  // PORT; M98E_WS carries the expansion grammar referencing the file's HOST.
  Deno.env.set('M98E_PORT', '3000');
  Deno.env.set('M98E_WS', 'ws://${HOST}:1234');

  // Resolve the runtime services the way an application composer would, so
  // the standalone load sees the real environment and filesystem — and the
  // plugin adopts the exact snapshot that load produced.
  const runtime = createRuntimeServices();
  const loaded = await loadConfig(runtime, {
    envFilePath: [CANARY_PATH],
    diagnostics: {
      enabled: true,
      keys: diagnosticsKeys(),
      files: { [CANARY_PATH]: 'dotenv' },
    },
  });

  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      DiagnosticsPlugin({
        enabled: true,
        port: connectorPort,
        sessionId: TEST_SESSION_ID,
        sessionKey: TEST_KEY_BYTES,
      }),
      ConfigPlugin({
        instance: loaded,
        diagnostics: {
          enabled: true,
          keys: diagnosticsKeys(),
          files: { [CANARY_PATH]: 'dotenv' },
        },
      }),
    ],
    diagnostics: {},
  });
  await app.start({ port: httpPort, hostname: '127.0.0.1' });
  return { app, connectorPort, instance: loaded };
}

describe('Configuration provenance e2e (M98e canary)', () => {
  it('serves useful approved provenance end to end while every canary stays absent', async () => {
    const { app, connectorPort } = await startConfigProvenanceApplication();
    try {
      const frames: string[] = [];
      const client = createDiagnosticsClient({
        endpoint: `http://127.0.0.1:${connectorPort}`,
        sessionId: TEST_SESSION_ID,
        sessionKey: TEST_KEY_BYTES,
        subtle: crypto.subtle,
        fetch: capturingFetch(frames),
        timing: { setTimeout, clearTimeout },
      });
      const instanceId = (await client.snapshot()).instanceId as string;
      const snapshot = await client.configuration();

      // --- Useful provenance survives -----------------------------------
      expect(snapshot.state).toEqual('ready');
      const byAlias = new Map(snapshot.entries.map((e) => [e.keyAlias, e]));
      // The environment displaced the file for PORT, and the displacement is
      // recorded under the approved alias only.
      expect(byAlias.get('port')).toMatchObject({
        origin: 'environment',
        overriddenSourceAliases: ['dotenv'],
        schemaEffect: 'not-configured',
      });
      // HOST keeps its real file origin with the approved source alias.
      expect(byAlias.get('host')).toMatchObject({
        origin: 'file',
        sourceAlias: 'dotenv',
      });
      // WS_URL carried the expansion grammar and references the approved
      // HOST alias.
      expect(byAlias.get('ws')).toMatchObject({
        expanded: true,
        referenceAliases: ['host'],
      });

      // The in-process source answers the same minimized projection.
      const source = app.services.get(CAPABILITIES.CONFIG_DIAGNOSTICS) as {
        snapshot: (instanceId: string) => { state: string; entries: unknown[] };
      };
      const sourceSnapshot = source.snapshot(instanceId);
      expect(sourceSnapshot.state).toEqual('ready');
      expect(sourceSnapshot.entries.length).toEqual(3);
      client.close();

      // --- Canaries are absent at every layer ---------------------------
      const canaries = [
        CANARY_FILE_VALUE,
        CANARY_FILE_HOST,
        RAW_FILE_NAME,
        UNAPPROVED_KEY,
        RAW_APPROVED_KEY,
      ];
      for (
        const layer of [
          JSON.stringify(sourceSnapshot),
          JSON.stringify(snapshot),
          ...frames,
        ]
      ) {
        for (const canary of canaries) {
          expect(layer).not.toContain(canary);
        }
      }
    } finally {
      await app.stop();
      Deno.env.delete('M98E_PORT');
      Deno.env.delete('M98E_WS');
    }
  });
});
