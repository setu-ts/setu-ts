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

import { afterEach, beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createDenoRuntimeServices } from '@setu-ts/runtime';
import type { IFileSystem } from '@setu-ts/common';
import { runCli } from '../../src/cli.ts';
import { bootAndProbe, unusedPort, useWorkspacePackages } from '../fixtures/generated-project.ts';
import { WORKSPACE_MANIFEST } from '../../src/workspace/manifest.ts';
import { DISCOVERY_MODULE } from '../../src/workspace/discovery-module.ts';

const runtime = createDenoRuntimeServices();
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
    const conn = await Deno.connect({ hostname, port: Number(port) });
    conn.close();
    return true;
  } catch {
    return false;
  }
}

/** Where the broker proof looks for a Redis, matching the transport default. */
const REDIS_URL = Deno.env.get('REDIS_URL') ?? 'redis://127.0.0.1:6379';

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
    root = await Deno.makeTempDir({ prefix: 'setu-mesh-' });
    base = unusedPort();
    log.length = 0;
  });

  afterEach(async () => {
    await Deno.remove(root, { recursive: true });
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
      await run(['new', 'acme', '--workspace', '--port', String(base), '--transport', transport]),
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

    const manifest = JSON.parse(await Deno.readTextFile(`${ws}/${WORKSPACE_MANIFEST}`)) as {
      members: { name: string; port: number }[];
    };
    expect(manifest.members).toEqual([
      { name: 'orders', port: base },
      { name: 'billing', port: base + 1 },
      { name: 'shipping', port: base + 2 },
    ]);

    // The full mesh: 3 members × 2 peers. A map that was appended to rather than
    // regenerated would leave `orders` knowing only `billing`.
    for (const [index, member] of MEMBERS.entries()) {
      const map = await Deno.readTextFile(`${ws}/apps/${member}/${DISCOVERY_MODULE}`);
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
    const { code, stderr } = await new Deno.Command(Deno.execPath(), {
      args: ['check', '--node-modules-dir=none', ...sources],
      cwd: ws,
      stdout: 'piped',
      stderr: 'piped',
    }).output().then((r) => ({ code: r.code, stderr: new TextDecoder().decode(r.stderr) }));

    // The broker literal is an opaque string to the CLI's own type-checker;
    // this is the only place a wrong discriminant or field is caught.
    expect(stderr).not.toContain('SyntaxError');
    expect(code).toBe(0);
  });

  it('has one service call BOTH its peers over HTTP', async () => {
    const ws = await mesh('http');
    await useWorkspace(ws);

    const servers = ['billing', 'shipping'].map((member) =>
      new Deno.Command(Deno.execPath(), {
        args: ['run', '-A', '--node-modules-dir=none', `${ws}/apps/${member}/main.ts`],
        stdout: 'piped',
        stderr: 'piped',
      }).spawn()
    );

    try {
      const result = await bootAndProbe(`${ws}/apps/orders`, MESH_PROBE) as Record<
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
      for (const server of servers) {
        server.kill();
        await server.status;
        await server.stdout.cancel();
        await server.stderr.cancel();
      }
    }
  });

  it('has one service call BOTH its peers over gRPC', async () => {
    const ws = await mesh('grpc');
    await useWorkspace(ws);

    const servers = ['billing', 'shipping'].map((member) =>
      new Deno.Command(Deno.execPath(), {
        args: ['run', '-A', '--node-modules-dir=none', `${ws}/apps/${member}/main.ts`],
        stdout: 'piped',
        stderr: 'piped',
      }).spawn()
    );

    try {
      const result = await bootAndProbe(`${ws}/apps/orders`, GRPC_PROBE) as Record<
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
      for (const server of servers) {
        server.kill();
        await server.status;
        await server.stdout.cancel();
        await server.stderr.cancel();
      }
    }
  });

  // The transport that actually leaves the process. Guarded on a live Redis and
  // reported when absent, never silently skipped as a pass.
  it('delivers a message from one service to another over the redis broker', async () => {
    if (!(await redisReachable(REDIS_URL))) {
      console.log(`SKIPPED: no Redis at ${REDIS_URL}`);
      return;
    }

    const ws = await mesh('redis');
    await useWorkspace(ws);

    // The subscriber runs first and stays up while the publisher fires.
    await Deno.writeTextFile(`${ws}/apps/billing/subscriber.ts`, BROKER_SUBSCRIBE_PROBE);
    const subscriber = new Deno.Command(Deno.execPath(), {
      args: [
        'run',
        '-A',
        '--node-modules-dir=none',
        '--config',
        `${ws}/apps/billing/deno.json`,
        `${ws}/apps/billing/subscriber.ts`,
      ],
      stdout: 'piped',
      stderr: 'piped',
    }).spawn();

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
        expect((await Deno.stat(`${dir}/${file}`)).isFile).toBe(true);
      }
      // Functional members have only the seams their composition can consume.
      for (const seam of ['routes', 'middleware', 'plugins']) {
        expect((await Deno.stat(`${dir}/src/${seam}/index.ts`)).isFile).toBe(true);
      }
      expect((await Deno.stat(`${dir}/${DISCOVERY_MODULE}`)).isFile).toBe(true);
    }
  });

  // Decorators and DI, reached with the CLI alone: no hand-edited config, no
  // hand-written wiring. The member is booted and its decorated route driven,
  // because a controller that compiles and answers 500 has shipped here before.
  it('serves a decorated, injected module generated entirely through the CLI', async () => {
    expect(
      await run(['new', 'acme', '--workspace', '--port', String(base)]),
    ).toBe(0);
    const ws = `${root}/acme`;
    expect(await run(['g', 'app', 'orders', '--template', 'class-based', '--dir', ws])).toBe(0);

    const project = `${ws}/apps/orders`;
    expect(await run(['g', 'module', 'widget', '--dir', project])).toBe(0);
    expect(await run(['g', 'service', 'pricing', '--dir', project])).toBe(0);
    expect(await run(['g', 'controller', 'invoice', '--dir', project])).toBe(0);

    // The container is registered, and the decorated artifacts are wired.
    const config = await Deno.readTextFile(`${project}/setu.config.ts`);
    expect(config).toContain('DiPlugin()');
    expect(config).toContain('DecoratorPlugin(');

    await useWorkspacePackages(project);
    const { code, stderr } = await new Deno.Command(Deno.execPath(), {
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
    }).output().then((r) => ({ code: r.code, stderr: new TextDecoder().decode(r.stderr) }));
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
    const result = await bootAndProbe(project, probe) as Record<
      string,
      { status: number; body: string }
    >;
    // 200, not 500: a decorated handler taking IRequestContext positionally
    // answered `Cannot read properties of undefined` for five releases.
    expect(result['/widget']?.status).toBe(200);
    expect(result['/invoice']?.status).toBe(200);
  });
});
