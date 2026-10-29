import { connect } from '../../../../test/node-helpers.ts';
import {
  denoBinary,
  run as runProcess,
  spawnProcess,
  tempDir,
} from '../../../../test/node-helpers.ts';
import * as nodeFs from 'node:fs/promises';
/**
 * The three-service gate: a workspace bigger than a pair, on a chosen transport,
 * with DI and decorators reached through the CLI alone.
 *
 * THREE members, not two, and that is the point. A two-member mesh cannot tell
 * "every member learns every other" apart from "the pair happens to know each
 * other" — both look identical when each map has exactly one entry. With three,
 * a map that is regenerated correctly has two entries and a map that is merely
 * appended to has one.
 *
 * @module
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNodeRuntimeServices } from '@setu-ts/runtime';
import type { IFileSystem } from '@setu-ts/common';
import { runCli } from '../../src/cli.ts';
import {
  bootAndProbe,
  unusedPortRange,
  useWorkspacePackages,
} from '../fixtures/generated-project.ts';
import { WORKSPACE_MANIFEST } from '../../src/workspace/manifest.ts';
import { DISCOVERY_MODULE } from '../../src/workspace/discovery-module.ts';

const runtime = createNodeRuntimeServices();
const fs: IFileSystem = runtime.fs!;

/** The three services every case in this file scaffolds. */
const MEMBERS = ['orders', 'billing', 'shipping'] as const;

/**
 * The probe `orders` runs: reach BOTH siblings, not just one.
 *
 * A caller that resolves only its first sibling would pass a two-member gate and
 * fail here, which is exactly the distinction three members buy.
 */
const MESH_PROBE = `import { CAPABILITIES } from '@setu-ts/common';
import type { IServiceDiscovery } from '@setu-ts/common';
import { createApp } from './setu.config.ts';

const app = await createApp();
await app.start();
const discovery = app.services.get<IServiceDiscovery>(CAPABILITIES.SERVICE_DISCOVERY);

const reached: Record<string, unknown> = {};
for (const peer of ['billing', 'shipping']) {
  const url = await discovery.resolveUrl(peer, '/');
  let status = 0;
  let body = '';
  for (let attempt = 0; attempt < 40 && status === 0; attempt += 1) {
    try {
      const response = await fetch(url ?? '');
      status = response.status;
      body = await response.text();
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  reached[peer] = { url, status, body };
}
// Its own name resolves to nothing: the map excludes self.
reached['self'] = await discovery.resolve('orders');

console.log('__PROBE_RESULT__' + JSON.stringify(reached));
await app.stop();
Deno.exit(0);
`;

/**
 * The probe for a gRPC workspace: call a sibling's co-served RPC.
 *
 * `grpc.health.v1.Health/Check` is served by a bare `GrpcPlugin()` with no
 * descriptors generated, so this proves the RPC wire without a proto toolchain.
 */
const GRPC_PROBE = `import { CAPABILITIES } from '@setu-ts/common';
import type { IServiceDiscovery } from '@setu-ts/common';
import { createApp } from './setu.config.ts';

const app = await createApp();
await app.start();
const discovery = app.services.get<IServiceDiscovery>(CAPABILITIES.SERVICE_DISCOVERY);

const out: Record<string, unknown> = {};
for (const peer of ['billing', 'shipping']) {
  // Workspace gRPC is deliberately mounted, so form CSRF can exempt only this
  // non-browser protocol surface rather than every POST in a full-stack member.
  const base = await discovery.resolveUrl(peer, '/grpc/grpc.health.v1.Health/Check');
  let status = 0;
  let body = '';
  for (let attempt = 0; attempt < 40 && status === 0; attempt += 1) {
    try {
      const response = await fetch(base ?? '', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      status = response.status;
      body = await response.text();
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  out[peer] = { status, body };
}

console.log('__PROBE_RESULT__' + JSON.stringify(out));
await app.stop();
Deno.exit(0);
`;

/**
 * Reports whether a Redis is listening, so the broker proof can guard on it.
 *
 * @param url - The endpoint to probe
 * @returns True when something accepts a connection
 */
async function redisReachable(url: string): Promise<boolean> {
  const { hostname, port } = new URL(url);
  try {
    const conn = await connect({ hostname, port: Number(port) });
    conn.close();
    return true;
  } catch {
    return false;
  }
}

/** Explicit opt-in: never discover or use a developer's local Redis implicitly. */
const REDIS_URL = process.env['REDIS_URL'];

/**
 * The probe for a broker workspace: publish from one service, receive in another.
 *
 * The messaging capability, not HTTP — this is the path that silently delivered
 * NOTHING while reporting success when every member held a private in-memory
 * broker.
 */
const BROKER_PUBLISH_PROBE = `import { CAPABILITIES } from '@setu-ts/common';
import type { IMessageBroker } from '@setu-ts/common';
import { createApp } from './setu.config.ts';

const app = await createApp();
await app.start();
const broker = app.services.get<IMessageBroker>(CAPABILITIES.MESSAGING);
await broker.publish('orders.created', { id: 42, from: 'orders' });
console.log('__PROBE_RESULT__' + JSON.stringify({ published: true }));
await app.stop();
Deno.exit(0);
`;

/** The subscriber half, run in the peer service. */
const BROKER_SUBSCRIBE_PROBE = `import { CAPABILITIES } from '@setu-ts/common';
import type { IMessageBroker } from '@setu-ts/common';
import { createApp } from './setu.config.ts';

const app = await createApp();
await app.start();
const broker = app.services.get<IMessageBroker>(CAPABILITIES.MESSAGING);
const seen: unknown[] = [];
await broker.subscribe('orders.created', (message) => { seen.push(message); });
console.log('SUBSCRIBER_READY');
setTimeout(async () => {
  console.log('__PROBE_RESULT__' + JSON.stringify({ received: seen }));
  await app.stop();
  Deno.exit(0);
}, 6000);
`;

/** A spawned peer, as {@linkcode spawnProcess} returns it. */
type Peer = ReturnType<typeof spawnProcess>;

/** A peer whose output is drained while it runs. */
interface IWatchedPeer {
  readonly server: Peer;
  /** Everything the peer has written to stdout and stderr so far. */
  readonly output: () => string;
  /** The exit code once the peer has exited. */
  readonly exited: () => number | undefined;
  /** Settles when both streams have ended. */
  readonly drained: Promise<unknown>;
}

/**
 * Starts draining a peer's stdout and stderr. A pipe nobody reads fills and stalls
 * the peer before it binds, and the text is what a "never bound" failure needs.
 * @param server - The spawned peer
 * @returns The watched peer
 */
function watchPeer(server: Peer): IWatchedPeer {
  let output = '';
  let code: number | undefined;
  const decoder = new TextDecoder();
  const pump = async (stream: ReadableStream<Uint8Array> | null): Promise<void> => {
    if (stream === null) return;
    for await (const chunk of stream) output += decoder.decode(chunk, { stream: true });
  };
  void server.status.then((status) => {
    code = status.code;
  });
  return {
    server,
    output: () => output,
    exited: () => code,
    drained: Promise.all([pump(server.stdout), pump(server.stderr)]),
  };
}

/** How long a cold peer may take to bind on a loaded CI runner. */
const BIND_DEADLINE_MS = 60_000;

/** Room for two peer binds plus the probe's own boot, past the 30 s default. */
const MESH_TIMEOUT_MS = 180_000;

/**
 * Waits until a peer answers on `url`, failing at once if it exits first.
 * @param peer - The watched peer
 * @param name - The member, for the failure message
 * @param url - The address it binds
 */
async function waitForBind(peer: IWatchedPeer, name: string, url: string): Promise<void> {
  const deadline = performance.now() + BIND_DEADLINE_MS;
  while (peer.exited() === undefined && performance.now() < deadline) {
    try {
      const response = await fetch(url);
      await response.body?.cancel();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  const state = peer.exited() === undefined ? 'still running' : `exited ${peer.exited()}`;
  expect.fail(`${name} never bound ${url} (${state}):\n${peer.output().slice(-4000)}`);
}

/**
 * Stops a peer and waits for its streams to end.
 * @param peer - The watched peer
 */
async function stopPeer(peer: IWatchedPeer): Promise<void> {
  // Guarded: a peer that failed to bind has ALREADY exited, and killing an exited
  // child throws out of the `finally`, replacing the failure that names the peer.
  try {
    peer.server.kill();
  } catch {
    // Already gone; its status and streams still need draining below.
  }
  await peer.server.status;
  await peer.drained;
}

describe('a three-service workspace — end to end', () => {
  let root: string;
  let base: number;
  const log: string[] = [];

  const run = (argv: readonly string[]) =>
    runCli(argv, {
      fs,
      cwd: root,
      now: () => runtime.now(),
      log: (m) => log.push(m),
      error: (m) => log.push(m),
    });

  beforeEach(async () => {
    root = await tempDir({ prefix: 'setu-mesh-' });
    // Every member's port, not just the first: see unusedPortRange.
    base = await unusedPortRange(3);
    log.length = 0;
  });

  afterEach(async () => {
    await nodeFs.rm(root, { recursive: true });
  });

  /**
   * Scaffolds a workspace on the given transport and adds all three members.
   *
   * @param transport - The `--transport` value
   * @param template - The template every member uses
   * @returns The workspace root
   */
  async function mesh(transport: string, template = 'microservice'): Promise<string> {
    expect(
      await run([
        'new',
        '--runtime',
        'deno',
        'acme',
        '--workspace',
        '--port',
        String(base),
        '--transport',
        transport,
      ]),
    ).toBe(0);
    const ws = `${root}/acme`;
    for (const member of MEMBERS) {
      expect(await run(['g', 'app', member, '--template', template, '--dir', ws])).toBe(0);
    }
    return ws;
  }

  /**
   * Repoints every member at this workspace so it runs from source.
   *
   * @param ws - The workspace root
   */
  async function useWorkspace(ws: string): Promise<void> {
    for (const member of MEMBERS) await useWorkspacePackages(`${ws}/apps/${member}`);
  }

  it('gives every member the address of every OTHER member', async () => {
    const ws = await mesh('http');

    const manifest = JSON.parse(await nodeFs.readFile(`${ws}/${WORKSPACE_MANIFEST}`, 'utf8')) as {
      members: { name: string; port: number }[];
    };
    // `healthProbes: true` — all three are generated with a template, so the
    // Kubernetes renderer gives them httpGet probes rather than tcpSocket (X2-7).
    expect(manifest.members).toEqual([
      { name: 'orders', port: base, healthProbes: true, metricsEndpoint: true },
      { name: 'billing', port: base + 1, healthProbes: true, metricsEndpoint: true },
      { name: 'shipping', port: base + 2, healthProbes: true, metricsEndpoint: true },
    ]);

    // The full mesh: 3 members × 2 peers. A map that was appended to rather than
    // regenerated would leave `orders` knowing only `billing`.
    for (const [index, member] of MEMBERS.entries()) {
      const map = await nodeFs.readFile(`${ws}/apps/${member}/${DISCOVERY_MODULE}`, 'utf8');
      expect(map).toContain(`export const SERVICE_PORT = ${base + index};`);
      for (const [peerIndex, peer] of MEMBERS.entries()) {
        if (peer === member) {
          expect(map).not.toContain(`'${peer}':`);
          continue;
        }
        expect(map).toContain(`'${peer}': [{`);
        expect(map).toContain(`port: ${base + peerIndex},`);
      }
    }
  });

  it('type-checks all three members from the workspace root', async () => {
    const ws = await mesh('redis');
    await useWorkspace(ws);

    const sources = MEMBERS.flatMap((m) => [
      `${ws}/apps/${m}/main.ts`,
      `${ws}/apps/${m}/setu.config.ts`,
      `${ws}/apps/${m}/${DISCOVERY_MODULE}`,
    ]);
    const { code, stderr } = await runProcess(denoBinary(), {
      args: ['check', '--node-modules-dir=none', ...sources],
      cwd: ws,
      stdout: 'piped',
      stderr: 'piped',
    }).then((r) => ({ code: r.code, stderr: new TextDecoder().decode(r.stderr) }));

    // The broker literal is an opaque string to the CLI's own type-checker;
    // this is the only place a wrong discriminant or field is caught.
    expect(stderr).not.toContain('SyntaxError');
    expect(code).toBe(0);
  });

  it(
    'has one service call BOTH its peers over HTTP',
    async () => {
      const ws = await mesh('http');
      await useWorkspace(ws);

      const peers = ['billing', 'shipping'].map((member) =>
        watchPeer(
          spawnProcess(denoBinary(), {
            args: ['run', '-A', '--node-modules-dir=none', `${ws}/apps/${member}/main.ts`],
            cwd: `${ws}/apps/${member}`,
            stdout: 'piped',
            stderr: 'piped',
          }),
        ),
      );

      try {
        // Wait for both peers to BIND before probing: under load the orders service
        // otherwise fetched a port nothing was listening on yet.
        for (const [index, peer] of (['billing', 'shipping'] as const).entries()) {
          await waitForBind(peers[index]!, peer, `http://127.0.0.1:${base + index + 1}/`);
        }

        const result = (await bootAndProbe(`${ws}/apps/orders`, MESH_PROBE)) as Record<
          string,
          { url: string; status: number; body: string }
        >;
        for (const [index, peer] of (['billing', 'shipping'] as const).entries()) {
          expect(result[peer]?.url).toBe(`http://127.0.0.1:${base + index + 1}/`);
          expect(result[peer]?.status).toBe(200);
          expect(String(result[peer]?.body)).toContain('Hello, World!');
        }
        expect(result['self']).toEqual([]);
      } finally {
        for (const peer of peers) await stopPeer(peer);
      }
    },
    MESH_TIMEOUT_MS,
  );

  it(
    'has one service call BOTH its peers over gRPC',
    async () => {
      const ws = await mesh('grpc');
      await useWorkspace(ws);

      const peers = ['billing', 'shipping'].map((member) =>
        watchPeer(
          spawnProcess(denoBinary(), {
            args: ['run', '-A', '--node-modules-dir=none', `${ws}/apps/${member}/main.ts`],
            cwd: `${ws}/apps/${member}`,
            stdout: 'piped',
            stderr: 'piped',
          }),
        ),
      );

      try {
        // The same bind wait as the HTTP mesh: a probe sent before a peer listens
        // reads as status 0.
        for (const [index, peer] of (['billing', 'shipping'] as const).entries()) {
          await waitForBind(peers[index]!, peer, `http://127.0.0.1:${base + index + 1}/`);
        }

        const result = (await bootAndProbe(`${ws}/apps/orders`, GRPC_PROBE)) as Record<
          string,
          { status: number; body: string }
        >;
        for (const peer of ['billing', 'shipping'] as const) {
          expect(result[peer]?.status).toBe(200);
          // The decoded RPC body, not merely a 200 — a fallthrough Hono 404 or an
          // empty body would otherwise read as success.
          expect(String(result[peer]?.body)).toContain('SERVING');
        }
      } finally {
        for (const peer of peers) await stopPeer(peer);
      }
    },
    MESH_TIMEOUT_MS,
  );

  // The transport that actually leaves the process. Guarded on a live Redis and
  // reported when absent, never silently skipped as a pass.
  it('delivers a message from one service to another over the redis broker', async (context) => {
    if (REDIS_URL === undefined || !(await redisReachable(REDIS_URL))) {
      context.skip('Redis backend opt-in (REDIS_URL) is absent or unavailable');
      return;
    }

    const ws = await mesh('redis');
    await useWorkspace(ws);

    // The subscriber runs first and stays up while the publisher fires.
    await nodeFs.writeFile(`${ws}/apps/billing/subscriber.ts`, BROKER_SUBSCRIBE_PROBE);
    const subscriber = spawnProcess(denoBinary(), {
      args: [
        'run',
        '-A',
        '--node-modules-dir=none',
        '--config',
        `${ws}/apps/billing/deno.json`,
        `${ws}/apps/billing/subscriber.ts`,
      ],
      cwd: `${ws}/apps/billing`,
      stdout: 'piped',
      stderr: 'piped',
    });

    try {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const published = await bootAndProbe(`${ws}/apps/orders`, BROKER_PUBLISH_PROBE);
      expect(published['published']).toBe(true);

      const out = new TextDecoder().decode((await subscriber.output()).stdout);
      const line = out.split('\n').find((l) => l.startsWith('__PROBE_RESULT__'));
      expect(line).toBeDefined();
      const received = JSON.parse(line?.slice('__PROBE_RESULT__'.length) ?? '{}') as {
        received: { id: number; from: string }[];
      };
      // The message CROSSED a process boundary — the thing the in-memory
      // default cannot do, and reported success at while doing nothing.
      expect(received.received).toContainEqual({ id: 42, from: 'orders' });
    } finally {
      try {
        subscriber.kill();
      } catch {
        // Already exited on its own timer.
      }
      await subscriber.status;
    }
  });

  // "Standard structure" is a claim the generated tree either honors or does
  // not; this reads the tree rather than trusting the templates.
  it('gives every member the same standard layout', async () => {
    const ws = await mesh('http');

    for (const member of MEMBERS) {
      const dir = `${ws}/apps/${member}`;
      for (const file of ['deno.json', 'main.ts', 'setu.config.ts', 'README.md', '.gitignore']) {
        expect((await nodeFs.stat(`${dir}/${file}`)).isFile()).toBe(true);
      }
      // Functional members have only the seams their composition can consume.
      for (const seam of ['controllers', 'middleware', 'plugins', 'modules']) {
        expect((await nodeFs.stat(`${dir}/src/${seam}/index.ts`)).isFile()).toBe(true);
      }
      expect((await nodeFs.stat(`${dir}/${DISCOVERY_MODULE}`)).isFile()).toBe(true);
      expect(await nodeFs.readFile(`${dir}/setu.config.ts`, 'utf8')).toContain(
        'registerModules(app.router, app.services)',
      );
      for (const file of ['test/support/server.ts', 'test/e2e/app.e2e.test.ts']) {
        expect((await nodeFs.stat(`${dir}/${file}`)).isFile()).toBe(true);
      }
    }
  });

  // Decorators and DI, reached with the CLI alone: no hand-edited config, no
  // hand-written wiring. The member is booted and its decorated route driven,
  // because a controller that compiles and answers 500 has shipped here before.
  it('serves a decorated, injected module generated entirely through the CLI', async () => {
    expect(
      await run(['new', '--runtime', 'deno', 'acme', '--workspace', '--port', String(base)]),
    ).toBe(0);
    const ws = `${root}/acme`;
    expect(await run(['g', 'app', 'orders', '--template', 'class-based', '--dir', ws])).toBe(0);

    const project = `${ws}/apps/orders`;
    expect(await run(['g', 'module', 'widget', '--dir', project])).toBe(0);
    expect(await run(['g', 'service', 'pricing', '--dir', project])).toBe(0);
    expect(await run(['g', 'controller', 'invoice', '--dir', project])).toBe(0);

    // The container is registered (since M70d with `autoRegister: true`, E3),
    // and the decorated artifacts are wired.
    const config = await nodeFs.readFile(`${project}/setu.config.ts`, 'utf8');
    expect(config).toContain('DiPlugin({ autoRegister: true })');
    expect(config).toContain('DecoratorPlugin(');

    await useWorkspacePackages(project);
    const { code, stderr } = await runProcess(denoBinary(), {
      args: [
        'check',
        '--node-modules-dir=none',
        '--config',
        `${project}/deno.json`,
        `${project}/main.ts`,
        `${project}/setu.config.ts`,
        `${project}/src/modules/widget/widget.controller.ts`,
        `${project}/src/services/pricing.service.ts`,
        `${project}/src/controllers/invoice.controller.ts`,
      ],
      stdout: 'piped',
      stderr: 'piped',
    }).then((r) => ({ code: r.code, stderr: new TextDecoder().decode(r.stderr) }));
    expect(stderr).not.toContain('SyntaxError');
    expect(code).toBe(0);

    const probe = `import { createApp } from './setu.config.ts';
const app = await createApp();
await app.start();
const out: Record<string, unknown> = {};
for (const path of ['/widget', '/invoice']) {
  const response = await app.fetch(new Request('http://x' + path));
  out[path] = { status: response.status, body: await response.text() };
}
console.log('__PROBE_RESULT__' + JSON.stringify(out));
await app.stop();
Deno.exit(0);
`;
    const result = (await bootAndProbe(project, probe)) as Record<
      string,
      { status: number; body: string }
    >;
    // 200, not 500: a decorated handler taking IRequestContext positionally
    // answered `Cannot read properties of undefined` for five releases.
    expect(result['/widget']?.status).toBe(200);
    expect(result['/invoice']?.status).toBe(200);
  });
});
