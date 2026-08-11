import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createFakeFs, createRecorder, type FakeFs } from '../fixtures/fake-fs.ts';
import { parseArgs } from '../../src/args.ts';
import { runAppCommand } from '../../src/commands/app.ts';
import {
  renderWorkspaceManifest,
  WORKSPACE_MANIFEST,
  WORKSPACE_VERSION,
  type WorkspaceMember,
} from '../../src/workspace/manifest.ts';
import { DISCOVERY_MODULE } from '../../src/workspace/discovery-module.ts';
import type { TransportName } from '../../src/workspace/transport.ts';

interface Harness {
  readonly fs: FakeFs;
  readonly out: ReturnType<typeof createRecorder>;
  readonly err: ReturnType<typeof createRecorder>;
  run(argv: readonly string[]): Promise<number>;
}

/**
 * Builds a harness over a workspace holding the given members.
 *
 * The argv it takes starts at the `app` verb, exactly as `generate` hands it
 * over, so `positionals[1]` is the member name.
 *
 * @param members - Members already in the workspace, or `undefined` for no
 * workspace at all
 * @param basePort - The workspace's base port
 * @returns The harness
 */
function harness(
  members?: readonly WorkspaceMember[],
  basePort = 3000,
  transport: TransportName = 'http',
): Harness {
  const seed: Record<string, string> = {};
  if (members !== undefined) {
    seed[`/ws/${WORKSPACE_MANIFEST}`] = renderWorkspaceManifest({
      version: WORKSPACE_VERSION,
      basePort,
      transport,
      members,
    });
  }
  const fs = createFakeFs(seed);
  const out = createRecorder();
  const err = createRecorder();
  return {
    fs,
    out,
    err,
    run: (argv) =>
      runAppCommand(parseArgs(argv), { fs, dir: '/ws', log: out.sink, error: err.sink }),
  };
}

describe('runAppCommand', () => {
  describe('usage', () => {
    it('prints its own usage under --help and exits 0', async () => {
      const h = harness([]);
      expect(await h.run(['app', '--help'])).toBe(0);
      expect(h.out.text()).toContain('generate app <name>');
      expect(h.out.text()).toContain('--template');
    });

    it('refuses a missing name with a usage error', async () => {
      const h = harness([]);
      expect(await h.run(['app'])).toBe(2);
      expect(h.err.text()).toContain('generate app <name>');
    });

    it('refuses a name that cannot form an identifier', async () => {
      const h = harness([]);
      expect(await h.run(['app', '2fa'])).toBe(2);
      expect(h.err.text()).toContain('must not start with a digit');
      expect(h.fs.writes).toEqual([]);
    });

    // Refused rather than ignored: a member is a Deno project by construction,
    // and swallowing the flag would hand back something it says it is not.
    it('refuses a non-Deno runtime, naming the standalone alternative', async () => {
      const h = harness([]);
      expect(await h.run(['app', 'orders', '--runtime', 'node'])).toBe(2);
      expect(h.err.text()).toContain('Deno workspace');
      expect(h.err.text()).toContain('setu new <name> --runtime node');
      expect(h.fs.writes).toEqual([]);
    });

    it('accepts an explicit --runtime deno', async () => {
      const h = harness([]);
      expect(await h.run(['app', 'orders', '--runtime', 'deno'])).toBe(0);
    });

    // Measured: a member may not declare `nodeModulesDir`, which that
    // template's Vite build needs, so it would scaffold and then fail to
    // resolve its own dependencies.
    it('refuses the full-stack template, naming nodeModulesDir', async () => {
      const h = harness([]);
      expect(await h.run(['app', 'shop', '--template', 'full-stack'])).toBe(2);
      expect(h.err.text()).toContain('nodeModulesDir');
      expect(h.fs.writes).toEqual([]);
    });

    // The transport is a workspace-wide choice: members can only talk over a bus
    // they share, so a per-member flag would make a workspace whose services
    // cannot reach each other expressible in one flag.
    for (const flag of ['--transport', '--transport-url']) {
      it(`refuses ${flag}, naming the workspace-level flag`, async () => {
        const h = harness([]);
        expect(await h.run(['app', 'orders', flag, 'redis'])).toBe(2);
        expect(h.err.text()).toContain('workspace-wide choice');
        expect(h.err.text()).toContain('new <name> --workspace');
        expect(h.fs.writes).toEqual([]);
      });
    }

    it('refuses an unknown template through the shared selector', async () => {
      const h = harness([]);
      expect(await h.run(['app', 'orders', '--template', 'nope'])).toBe(2);
      expect(h.err.text()).toContain('Unknown template "nope"');
    });

    // Through the same reader `setu new --workspace --port` uses, so a value the
    // one flag site rejects can never be accepted by the other.
    it('refuses a member port no service can bind', async () => {
      const h = harness([]);
      expect(await h.run(['app', 'orders', '--port', '99999'])).toBe(2);
      expect(h.err.text()).toContain('Invalid --port "99999"');
      expect(h.fs.writes).toEqual([]);
    });

    // `parseArgs` records a valued flag as boolean `true` when the next token is
    // flag-shaped or absent, so a negative number reads as "no value" rather
    // than as the number the user typed.
    it('refuses --port with no value', async () => {
      const h = harness([]);
      expect(await h.run(['app', 'orders', '--port'])).toBe(2);
      expect(h.err.text()).toContain('--port needs a value');
      expect(h.fs.writes).toEqual([]);
    });
  });

  describe('--port', () => {
    it('binds the requested port instead of the allocated one', async () => {
      const h = harness([{ name: 'orders', port: 3000 }]);
      expect(await h.run(['app', 'billing', '--port', '4444'])).toBe(0);

      const manifest = JSON.parse(h.fs.read(`/ws/${WORKSPACE_MANIFEST}`)) as {
        members: { name: string; port: number }[];
      };
      expect(manifest.members).toEqual([
        { name: 'orders', port: 3000 },
        { name: 'billing', port: 4444 },
      ]);
      // The chosen port has to reach BOTH sides of the one datum: what this
      // member binds, and what its sibling dials.
      expect(h.fs.read(`/ws/apps/billing/${DISCOVERY_MODULE}`)).toContain(
        'export const SERVICE_PORT = 4444;',
      );
      expect(h.fs.read(`/ws/apps/orders/${DISCOVERY_MODULE}`)).toContain(
        `'billing': [{ host: '127.0.0.1', port: 4444 }]`,
      );
    });

    // Two members on one port cannot both start, and every sibling's map names
    // both — so one name resolves to the other service. The collision is between
    // a flag and a file, so this command is the only place that can see it.
    it('refuses a port another member already binds, naming that member', async () => {
      const h = harness([{ name: 'orders', port: 3000 }]);
      expect(await h.run(['app', 'billing', '--port', '3000'])).toBe(1);
      expect(h.err.text()).toContain('already bound by the member "orders"');
      expect(h.fs.writes).toEqual([]);
    });

    // Allocation is derived from the HIGHEST port in use, so a hand-picked port
    // above the base moves the ceiling rather than being skipped over — the next
    // member cannot land on it.
    it('allocates above a hand-picked port for the next member', async () => {
      const h = harness([{ name: 'orders', port: 3000 }]);
      expect(await h.run(['app', 'billing', '--port', '4444'])).toBe(0);

      const next = harness(
        JSON.parse(h.fs.read(`/ws/${WORKSPACE_MANIFEST}`)).members as WorkspaceMember[],
      );
      expect(await next.run(['app', 'shipping'])).toBe(0);
      const manifest = JSON.parse(next.fs.read(`/ws/${WORKSPACE_MANIFEST}`)) as {
        members: { name: string; port: number }[];
      };
      expect(manifest.members.at(-1)).toEqual({ name: 'shipping', port: 4445 });
    });

    // The escape hatch from the exhausted-range refusal the workspace gate
    // covers: an explicit port is never allocated, so a workspace based at the
    // top of the range can still take a member.
    it('takes a member even when allocation has no port left', async () => {
      const h = harness([{ name: 'orders', port: 65535 }], 65535);
      expect(await h.run(['app', 'billing', '--port', '3000'])).toBe(0);
      expect(h.fs.read(`/ws/apps/billing/${DISCOVERY_MODULE}`)).toContain(
        'export const SERVICE_PORT = 3000;',
      );
    });
  });

  describe('the workspace gate', () => {
    it('refuses outside a workspace, naming how to make one', async () => {
      const h = harness(undefined);
      expect(await h.run(['app', 'orders'])).toBe(1);
      expect(h.err.text()).toContain(WORKSPACE_MANIFEST);
      expect(h.err.text()).toContain('--workspace');
      expect(h.fs.writes).toEqual([]);
    });

    it('refuses a malformed manifest distinctly from an absent one', async () => {
      const fs = createFakeFs({ [`/ws/${WORKSPACE_MANIFEST}`]: '{ not json' });
      const err = createRecorder();
      const code = await runAppCommand(parseArgs(['app', 'orders']), {
        fs,
        dir: '/ws',
        log: createRecorder().sink,
        error: err.sink,
      });
      expect(code).toBe(1);
      expect(err.text()).toContain('not a readable workspace manifest');
    });

    it('refuses a manifest version it does not understand', async () => {
      const fs = createFakeFs({
        [`/ws/${WORKSPACE_MANIFEST}`]: '{"version":99,"basePort":3000,"members":[]}',
      });
      const err = createRecorder();
      const code = await runAppCommand(parseArgs(['app', 'orders']), {
        fs,
        dir: '/ws',
        log: createRecorder().sink,
        error: err.sink,
      });
      expect(code).toBe(1);
      expect(err.text()).toContain('declares version 99');
    });

    // The defect this closes: an out-of-range port was accepted and written
    // into the member's own `main.ts` binding AND into every sibling's map, so
    // `generate app` reported success while producing a workspace whose members
    // throw `Invalid port (out of range)` on start.
    it('refuses a member port no service can bind, naming the value', async () => {
      const fs = createFakeFs({
        [`/ws/${WORKSPACE_MANIFEST}`]:
          '{"version":1,"basePort":3000,"members":[{"name":"orders","port":99999}]}',
      });
      const err = createRecorder();
      const code = await runAppCommand(parseArgs(['app', 'billing']), {
        fs,
        dir: '/ws',
        log: createRecorder().sink,
        error: err.sink,
      });
      expect(code).toBe(1);
      expect(err.text()).toContain('99999');
      expect(err.text()).toContain('orders');
      expect(fs.writes).toEqual([]);
    });

    it('refuses a workspace with no port left to allocate', async () => {
      const h = harness([{ name: 'orders', port: 65535 }], 65535);
      expect(await h.run(['app', 'billing'])).toBe(1);
      expect(h.err.text()).toContain('no port left to allocate');
      expect(h.fs.writes).toEqual([]);
    });

    it('refuses a manifest naming a transport it does not know', async () => {
      const fs = createFakeFs({
        [`/ws/${WORKSPACE_MANIFEST}`]:
          '{"version":1,"basePort":3000,"transport":"carrier-pigeon","members":[]}',
      });
      const err = createRecorder();
      const code = await runAppCommand(parseArgs(['app', 'orders']), {
        fs,
        dir: '/ws',
        log: createRecorder().sink,
        error: err.sink,
      });
      expect(code).toBe(1);
      expect(err.text()).toContain('carrier-pigeon');
      expect(fs.writes).toEqual([]);
    });

    it('inherits the workspace transport for every member it adds', async () => {
      const h = harness([], 3000, 'redis');
      expect(await h.run(['app', 'orders', '--template', 'microservice'])).toBe(0);
      expect(h.fs.read('/ws/apps/orders/setu.config.ts')).toContain(
        "MessagingPlugin({ broker: 'redis-streams', url: 'redis://127.0.0.1:6379' })",
      );
    });

    it('registers the gRPC plugin in every member of a grpc workspace', async () => {
      const h = harness([], 3000, 'grpc');
      expect(await h.run(['app', 'orders', '--template', 'microservice'])).toBe(0);
      const config = h.fs.read('/ws/apps/orders/setu.config.ts');
      expect(config).toContain("import { GrpcPlugin } from '@setu-ts/grpc-plugin';");
      expect(config).toContain('GrpcPlugin(),');
      // …and declares it, or the member imports a package it does not have.
      expect(h.fs.read('/ws/apps/orders/deno.json')).toContain('@setu-ts/grpc-plugin');
    });

    it('refuses a duplicate member, naming the directory it already has', async () => {
      const h = harness([{ name: 'orders', port: 3000 }]);
      expect(await h.run(['app', 'orders'])).toBe(1);
      expect(h.err.text()).toContain('apps/orders');
      expect(h.fs.writes).toEqual([]);
    });
  });

  describe('the first member', () => {
    it('creates the member project under apps/', async () => {
      const h = harness([]);
      expect(await h.run(['app', 'orders'])).toBe(0);
      for (const file of ['deno.json', 'main.ts', 'setu.config.ts', 'README.md']) {
        expect(h.fs.has(`/ws/apps/orders/${file}`)).toBe(true);
      }
    });

    it('binds the allocated port through the generated module, not a literal', async () => {
      const h = harness([]);
      await h.run(['app', 'orders']);
      const main = h.fs.read('/ws/apps/orders/main.ts');
      expect(main).toContain(`import { SERVICE_PORT } from './${DISCOVERY_MODULE}';`);
      expect(main).toContain('await app.start({ port: SERVICE_PORT });');
      expect(h.fs.read(`/ws/apps/orders/${DISCOVERY_MODULE}`)).toContain(
        'export const SERVICE_PORT = 3000;',
      );
    });

    it('records the member and its port in the workspace manifest', async () => {
      const h = harness([]);
      await h.run(['app', 'orders']);
      expect(JSON.parse(h.fs.read(`/ws/${WORKSPACE_MANIFEST}`))).toEqual({
        version: WORKSPACE_VERSION,
        basePort: 3000,
        transport: 'http',
        members: [{ name: 'orders', port: 3000 }],
      });
    });

    it('allocates from the workspace base port', async () => {
      const h = harness([], 4100);
      await h.run(['app', 'orders']);
      expect(h.fs.read(`/ws/apps/orders/${DISCOVERY_MODULE}`)).toContain(
        'export const SERVICE_PORT = 4100;',
      );
    });

    it('reports the allocated port and how to run the member', async () => {
      const h = harness([]);
      await h.run(['app', 'orders']);
      expect(h.out.text()).toContain('Added orders on port 3000');
      expect(h.out.text()).toContain('cd apps/orders && deno task start');
    });

    it('normalizes the member name', async () => {
      const h = harness([]);
      expect(await h.run(['app', 'OrderItem'])).toBe(0);
      expect(h.fs.has('/ws/apps/order-item/main.ts')).toBe(true);
    });
  });

  describe('a member with the discovery plugin', () => {
    it('wires the config at the generated map', async () => {
      const h = harness([]);
      expect(await h.run(['app', 'orders', '--template', 'microservice'])).toBe(0);
      const config = h.fs.read('/ws/apps/orders/setu.config.ts');
      expect(config).toContain(
        `import { SERVICE_ENDPOINTS } from './${DISCOVERY_MODULE}';`,
      );
      expect(config).toContain(
        `ServiceDiscoveryPlugin({ provider: 'static', services: SERVICE_ENDPOINTS })`,
      );
      expect(config).not.toContain('services: {}');
    });

    it('leaves a member without that plugin unwired to the map', async () => {
      const h = harness([]);
      expect(await h.run(['app', 'web', '--template', 'rest'])).toBe(0);
      expect(h.fs.read('/ws/apps/web/setu.config.ts')).not.toContain('SERVICE_ENDPOINTS');
      // It still carries the module, because `main.ts` reads the port from it.
      expect(h.fs.has(`/ws/apps/web/${DISCOVERY_MODULE}`)).toBe(true);
    });

    it('passes --di through to the member', async () => {
      const h = harness([]);
      expect(await h.run(['app', 'orders', '--di'])).toBe(0);
      expect(h.fs.read('/ws/apps/orders/setu.config.ts')).toContain('DiPlugin()');
    });
  });

  describe('a second member', () => {
    /**
     * Adds `billing` to a workspace that already holds `orders`.
     *
     * @returns The harness, after the second member is added
     */
    async function twoMembers(): Promise<Harness> {
      const h = harness([]);
      expect(await h.run(['app', 'orders', '--template', 'microservice'])).toBe(0);
      expect(await h.run(['app', 'billing', '--template', 'microservice'])).toBe(0);
      return h;
    }

    it('allocates the next port', async () => {
      const h = await twoMembers();
      expect(h.fs.read(`/ws/apps/billing/${DISCOVERY_MODULE}`)).toContain(
        'export const SERVICE_PORT = 3001;',
      );
    });

    // The whole point: adding a service registers it with its CALLERS. A
    // sibling that never learns the new name resolves it to `[]`.
    it('rewrites the first member map to name it', async () => {
      const h = await twoMembers();
      const orders = h.fs.read(`/ws/apps/orders/${DISCOVERY_MODULE}`);
      expect(orders).toContain(`'billing': [{ host: '127.0.0.1', port: 3001 }]`);
      expect(orders).not.toContain(`'orders':`);
    });

    it('gives the new member the first one address', async () => {
      const h = await twoMembers();
      const billing = h.fs.read(`/ws/apps/billing/${DISCOVERY_MODULE}`);
      expect(billing).toContain(`'orders': [{ host: '127.0.0.1', port: 3000 }]`);
    });

    // The regenerated modules are `managed`, so rewriting them is not an
    // overwrite; without that flag the second member would be refused outright.
    it('rewrites an existing member module without refusing', async () => {
      const h = await twoMembers();
      expect(h.err.text()).not.toContain('Refusing to overwrite');
      expect(h.fs.writes).toContain(`/ws/apps/orders/${DISCOVERY_MODULE}`);
    });

    it('records both members in the manifest', async () => {
      const h = await twoMembers();
      expect(JSON.parse(h.fs.read(`/ws/${WORKSPACE_MANIFEST}`))).toMatchObject({
        members: [{ name: 'orders', port: 3000 }, { name: 'billing', port: 3001 }],
      });
    });
  });

  describe('safety', () => {
    it('writes nothing under --dry-run but prints the whole plan', async () => {
      const h = harness([{ name: 'orders', port: 3000 }]);
      expect(await h.run(['app', 'billing', '--dry-run'])).toBe(0);
      expect(h.fs.writes).toEqual([]);
      const plan = h.out.text();
      expect(plan).toContain('/ws/apps/billing/main.ts');
      expect(plan).toContain(`/ws/apps/orders/${DISCOVERY_MODULE}`);
      expect(plan).toContain(`/ws/${WORKSPACE_MANIFEST}`);
    });

    it('refuses when a member source file already exists', async () => {
      const h = harness([]);
      await h.fs.writeFile('/ws/apps/orders/main.ts', new TextEncoder().encode('mine'));
      expect(await h.run(['app', 'orders'])).toBe(1);
      expect(h.err.text()).toContain('Refusing to overwrite existing files');
      expect(h.fs.read('/ws/apps/orders/main.ts')).toBe('mine');
    });

    it('reports a write failure rather than throwing', async () => {
      const h = harness([]);
      const failing = {
        ...h.fs,
        writeFile: () => Promise.reject(new Error('disk full')),
      };
      const err = createRecorder();
      const code = await runAppCommand(parseArgs(['app', 'orders']), {
        fs: failing,
        dir: '/ws',
        log: createRecorder().sink,
        error: err.sink,
      });
      expect(code).toBe(1);
      expect(err.text()).toContain('disk full');
    });
  });
});
