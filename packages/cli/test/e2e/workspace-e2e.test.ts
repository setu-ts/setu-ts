/**
 * The workspace gate: scaffolds a monorepo, adds two members, type-checks both,
 * and then BOOTS them — one member resolving and calling the other through the
 * discovery capability.
 *
 * The boot is the milestone's bar, not decoration. The map the CLI generates and
 * the port each member binds are the same datum by construction, and the only
 * thing that can prove it is a request that arrives: a member whose `main.ts`
 * carried a literal port would type-check, scaffold cleanly, and answer nothing
 * at the address its sibling dials.
 *
 * @module
 */

import { afterEach, beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createDenoRuntimeServices } from '@setu-ts/runtime';
import type { IFileSystem } from '@setu-ts/common';
import { runCli } from '../../src/cli.ts';
import {
  bootAndProbe,
  denoCheck,
  unusedPort,
  useWorkspacePackages,
} from '../fixtures/generated-project.ts';
import { WORKSPACE_MANIFEST } from '../../src/workspace/manifest.ts';
import { DISCOVERY_MODULE } from '../../src/workspace/discovery-module.ts';

const runtime = createDenoRuntimeServices();
const fs: IFileSystem = runtime.fs!;

/**
 * The probe `orders` runs: resolve `billing` through the discovery capability
 * and call it.
 *
 * It reads the capability from the service registry rather than the generated
 * source, so a map that compiles but reaches the plugin as `{}` fails here.
 */
const RESOLVE_PROBE = `import { CAPABILITIES } from '@setu-ts/common';
import type { IServiceDiscovery } from '@setu-ts/common';
import { createApp } from './setu.config.ts';

const app = await createApp();
await app.start();

const discovery = app.services.get<IServiceDiscovery>(CAPABILITIES.SERVICE_DISCOVERY);
const instances = await discovery.resolve('billing');
const url = await discovery.resolveUrl('billing', '/');

const out: Record<string, unknown> = {
  instances: instances.map((i) => ({ host: i.host, port: i.port })),
  url,
  self: await discovery.resolve('orders'),
};

// The call that proves the generated map and the sibling's binding agree.
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
out['status'] = status;
out['body'] = body;

console.log('__PROBE_RESULT__' + JSON.stringify(out));
await app.stop();
Deno.exit(0);
`;

describe('workspace scaffolding — end to end', () => {
  let root: string;
  let out: string[];
  let err: string[];
  let base: number;

  const run = (argv: readonly string[]) =>
    runCli(argv, {
      fs,
      cwd: root,
      now: () => runtime.now(),
      log: (m) => out.push(m),
      error: (m) => err.push(m),
    });

  beforeEach(async () => {
    root = await Deno.makeTempDir({ prefix: 'setu-ws-' });
    out = [];
    err = [];
    base = unusedPort();
  });

  afterEach(async () => {
    await Deno.remove(root, { recursive: true });
  });

  /**
   * Creates the workspace and adds `orders` and `billing` as microservice
   * members.
   *
   * @returns The workspace root directory
   */
  async function twoMembers(): Promise<string> {
    expect(await run(['new', 'acme', '--workspace', '--port', String(base)])).toBe(0);
    const ws = `${root}/acme`;
    expect(await run(['g', 'app', 'orders', '--template', 'microservice', '--dir', ws])).toBe(0);
    expect(await run(['g', 'app', 'billing', '--template', 'microservice', '--dir', ws])).toBe(0);
    return ws;
  }

  it('is formatted and lints clean, like a scaffolded project', async () => {
    // M63 established this bar for `setu new <name>` and `scaffold-runs-e2e`
    // gates it there — but only there, so a workspace could be, and was, emitted
    // failing both while every gate stayed green. The offenders were CLI-owned
    // files the developer never wrote: the generated `scripts/dev.ts` (two empty
    // `catch` blocks, and lines past the width its own `fmt` config sets) and a
    // root README paragraph hand-wrapped to the wrong column.
    const ws = await twoMembers();

    for (const argv of [['fmt', '--check'], ['lint']]) {
      const { code, stdout, stderr } = await new Deno.Command(Deno.execPath(), {
        args: argv,
        cwd: ws,
        stdout: 'piped',
        stderr: 'piped',
      }).output();
      const decoder = new TextDecoder();
      expect(code, `${argv.join(' ')}: ${decoder.decode(stdout)}${decoder.decode(stderr)}`).toBe(0);
    }
  });

  // X2-4: a brand-new `--transport rabbitmq` workspace failed its own formatter
  // on FIVE files before anything was edited, while the identical scaffold on the
  // default `--transport http` was clean — so the defect was in the transport
  // renderer, and the gate above could not see it because it only ever used the
  // default. `setu generate command-handler` had the same defect independently.
  it('is formatted and lints clean with a BROKER transport, and after generating', async () => {
    expect(await run(['new', 'acme', '--workspace', '--transport', 'rabbitmq'])).toBe(0);
    const ws = `${root}/acme`;
    expect(await run(['g', 'app', 'orders', '--template', 'microservice', '--dir', ws])).toBe(0);

    /** Runs one Deno subcommand in the workspace and returns its outcome. */
    const check = async (argv: readonly string[]) => {
      const { code, stdout, stderr } = await new Deno.Command(Deno.execPath(), {
        args: [...argv],
        cwd: ws,
        stdout: 'piped',
        stderr: 'piped',
      }).output();
      const decoder = new TextDecoder();
      return { code, output: `${decoder.decode(stdout)}${decoder.decode(stderr)}` };
    };

    const scaffolded = await check(['fmt', '--check']);
    expect(scaffolded.code, scaffolded.output).toBe(0);

    // The generate half: the CQRS barrel rendered its array on one long line.
    expect(
      await run(['g', 'command-handler', 'place-order', '--dir', `${ws}/apps/orders`]),
    ).toBe(0);
    const generated = await check(['fmt', '--check']);
    expect(generated.code, generated.output).toBe(0);

    const linted = await check(['lint']);
    expect(linted.code, linted.output).toBe(0);
  });

  // The gate the one above could not be. It generated exactly ONE artifact, of the
  // one family that had been fixed — and a barrel only overflows once it lists
  // enough names, so a single-artifact check can never see the defect it exists
  // for. Measured with three artifacts per family: the plugins barrel rendered a
  // 123-column declaration and the CQRS, events and middleware barrels rendered
  // 103-112-column IMPORT lines, so a project failed its own `deno fmt --check`
  // on three files the CLI had just written. X2-4 exactly, in the milestone that
  // claimed to have removed it as a class.
  //
  // Three is the smallest count that overflows a typical declaration, and every
  // family is swept because the width was a per-caller guess: six of the eight
  // call sites never overrode the default.
  it('stays formatted after generating THREE artifacts of every family', async () => {
    expect(await run(['new', 'shop', '--template', 'microservice'])).toBe(0);
    const project = `${root}/shop`;

    const families = [
      'plugin',
      'service',
      'metric',
      'health-indicator',
      'command-handler',
      'query-handler',
      'event-handler',
      'middleware',
      'route',
    ] as const;

    // Names long enough to be ordinary rather than adversarial — the defect does
    // not need a hostile name, only a real one.
    for (const name of ['payment-gateway', 'user-directory', 'order-archive']) {
      for (const family of families) {
        expect(await run(['g', family, name, '--dir', project]), `${family} ${name}`).toBe(0);
      }
    }

    const formatted = await new Deno.Command(Deno.execPath(), {
      args: ['fmt', '--check'],
      cwd: project,
      stdout: 'piped',
      stderr: 'piped',
    }).output();
    const decoder = new TextDecoder();
    expect(
      formatted.code,
      `${decoder.decode(formatted.stdout)}${decoder.decode(formatted.stderr)}`,
    ).toBe(0);

    // Belt and braces on the property itself, so a future `fmt` default that
    // tolerated a long line could not silently retire this check.
    for (const family of ['plugins', 'services', 'metrics', 'health', 'cqrs', 'events']) {
      const barrel = await Deno.readTextFile(`${project}/src/${family}/index.ts`).catch(() => '');
      for (const line of barrel.split('\n')) {
        expect(line.length, `${family}/index.ts: ${line}`).toBeLessThanOrEqual(100);
      }
    }
  });

  it('creates a root whose files exist on disk', async () => {
    expect(await run(['new', 'acme', '--workspace'])).toBe(0);
    for (const name of ['deno.json', WORKSPACE_MANIFEST, 'README.md', '.gitignore']) {
      expect((await Deno.stat(`${root}/acme/${name}`)).isFile).toBe(true);
    }
  });

  it('records both members with distinct ports', async () => {
    const ws = await twoMembers();
    const manifest = JSON.parse(await Deno.readTextFile(`${ws}/${WORKSPACE_MANIFEST}`)) as {
      members: { name: string; port: number }[];
    };
    // `healthProbes` records what the Kubernetes renderer cannot otherwise know:
    // both were generated with `--template microservice`, which reaches
    // HealthPlugin, so both get httpGet probes rather than tcpSocket (X2-7).
    expect(manifest.members).toEqual([
      { name: 'orders', port: base, healthProbes: true },
      { name: 'billing', port: base + 1, healthProbes: true },
    ]);
  });

  it('gives each member the other address', async () => {
    const ws = await twoMembers();
    const orders = await Deno.readTextFile(`${ws}/apps/orders/${DISCOVERY_MODULE}`);
    const billing = await Deno.readTextFile(`${ws}/apps/billing/${DISCOVERY_MODULE}`);
    expect(orders).toContain("host: Deno.env.get('BILLING_HOST') ?? '127.0.0.1'");
    expect(orders).toContain(`port: ${base + 1},`);
    expect(billing).toContain("host: Deno.env.get('ORDERS_HOST') ?? '127.0.0.1'");
    expect(billing).toContain(`port: ${base},`);
  });

  it('reallocates occupied ports across the manifest and every generated artifact', async () => {
    const ws = await twoMembers();
    const code = await runCli(['workspace', 'ports', '--reallocate', '--dir', ws], {
      fs,
      cwd: root,
      now: () => runtime.now(),
      log: (message) => out.push(message),
      error: (message) => err.push(message),
      // The first and third candidates are occupied by unrelated local work;
      // the planner must preserve member order while finding the next two.
      portAvailable: (port) => Promise.resolve(port !== base && port !== base + 2),
    });

    expect(code).toBe(0);
    const manifest = await Deno.readTextFile(`${ws}/${WORKSPACE_MANIFEST}`);
    expect(manifest).toContain(`"port": ${base + 1}`);
    expect(manifest).toContain(`"port": ${base + 3}`);
    expect(await Deno.readTextFile(`${ws}/apps/orders/${DISCOVERY_MODULE}`)).toContain(
      `port: ${base + 3}`,
    );
    expect(await Deno.readTextFile(`${ws}/docker/compose.yaml`)).toContain(`${base + 1}:`);
    expect(await Deno.readTextFile(`${ws}/k8s/members.yaml`)).toContain(
      `containerPort: ${base + 3}`,
    );
  });

  it('gives every member the start task the root dev task runs', async () => {
    const ws = await twoMembers();
    const root = JSON.parse(await Deno.readTextFile(`${ws}/deno.json`)) as {
      tasks?: Record<string, string>;
    };
    expect(root.tasks?.['dev']).toBe(
      'deno run --allow-read --allow-run --allow-net scripts/dev.ts',
    );
    for (const member of ['orders', 'billing']) {
      const manifest = JSON.parse(
        await Deno.readTextFile(`${ws}/apps/${member}/deno.json`),
      ) as { tasks?: Record<string, string> };
      expect(manifest.tasks?.['start']).toContain('main.ts');
    }
  });

  it('does not start a dependent until its prerequisite answers /ready', async () => {
    expect(await run(['new', 'acme', '--workspace', '--port', String(base)])).toBe(0);
    const ws = `${root}/acme`;
    expect(await run(['g', 'app', 'orders', '--template', 'microservice', '--dir', ws])).toBe(0);
    expect(
      await run([
        'g',
        'app',
        'billing',
        '--template',
        'microservice',
        '--depends-on',
        'orders',
        '--dir',
        ws,
      ]),
    ).toBe(0);
    for (const member of ['orders', 'billing']) await useWorkspacePackages(`${ws}/apps/${member}`);

    const ordersMain = `${ws}/apps/orders/main.ts`;
    const original = await Deno.readTextFile(ordersMain);
    await Deno.writeTextFile(
      ordersMain,
      original.replace(
        'const app = await createApp();',
        'await new Promise((resolve) => setTimeout(resolve, 800));\nconst app = await createApp();',
      ),
    );

    const dev = new Deno.Command(Deno.execPath(), {
      args: ['task', 'dev'],
      cwd: ws,
      stdout: 'piped',
      stderr: 'piped',
    }).spawn();
    const stdout = new Response(dev.stdout).text();
    const stderr = new Response(dev.stderr).text();
    try {
      await new Promise((resolve) => setTimeout(resolve, 250));
      await expect(fetch(`http://127.0.0.1:${base + 1}/ready`)).rejects.toThrow();

      let ready = false;
      for (let attempt = 0; attempt < 100 && !ready; attempt += 1) {
        try {
          ready = (await fetch(`http://127.0.0.1:${base + 1}/ready`)).ok;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      if (!ready) {
        try {
          dev.kill('SIGTERM');
        } catch {
          // The runner already exited; the captured output below explains why.
        }
        await dev.status;
        throw new Error(
          `Workspace dev runner did not start billing:\n${await stdout}\n${await stderr}`,
        );
      }
    } finally {
      try {
        dev.kill('SIGTERM');
      } catch {
        // A startup failure already terminated the runner; its captured streams
        // below still need releasing so Deno's resource sanitizer can finish.
      }
      await dev.status;
      await stdout;
      await stderr;
    }
  });

  // Two things at once, and the second is what makes it a workspace test rather
  // than a type check. A member's `args` string, its generated map, and its
  // config's local import are rendered source nothing else validates — and the
  // check is run from the workspace ROOT with NO `--config`, while every
  // framework pin lives in the MEMBER manifests. It can only resolve if Deno
  // discovered the root's glob and applied each member's own config to the files
  // inside it.
  it('type-checks both members from the workspace root, through the glob', async () => {
    const ws = await twoMembers();
    const sources: string[] = [];
    for (const member of ['orders', 'billing']) {
      const project = `${ws}/apps/${member}`;
      await useWorkspacePackages(project);
      sources.push(
        `${project}/main.ts`,
        `${project}/setu.config.ts`,
        `${project}/${DISCOVERY_MODULE}`,
      );
    }

    const command = new Deno.Command(Deno.execPath(), {
      args: ['check', '--node-modules-dir=none', ...sources],
      cwd: ws,
      stdout: 'piped',
      stderr: 'piped',
    });
    const { code, stderr } = await command.output();
    const text = new TextDecoder().decode(stderr);
    expect(text).not.toContain('SyntaxError');
    expect(code).toBe(0);
  });

  // The FIRST member's map is `{}`, and an empty object literal reaching a
  // `Readonly<Record<string, readonly StaticServiceDefinition[]>>` parameter is
  // exactly the shape no unit test can check — the two-member case above never
  // exercises it, because by then both maps have an entry.
  it('type-checks a lone member, whose map is empty', async () => {
    expect(await run(['new', 'solo', '--workspace', '--port', String(base)])).toBe(0);
    const ws = `${root}/solo`;
    expect(await run(['g', 'app', 'orders', '--template', 'microservice', '--dir', ws])).toBe(0);

    const project = `${ws}/apps/orders`;
    expect(await Deno.readTextFile(`${project}/${DISCOVERY_MODULE}`)).toContain(
      'export const SERVICE_ENDPOINTS = {};',
    );

    await useWorkspacePackages(project);
    const { code, stderr } = await denoCheck(project, [
      `${project}/main.ts`,
      `${project}/setu.config.ts`,
    ]);
    expect(stderr).not.toContain('SyntaxError');
    expect(code).toBe(0);
  });

  // A frontend member was refused outright until its one real blocker was
  // measured: its Vite build needs `node_modules`, and Deno accepts
  // `nodeModulesDir` only in the workspace ROOT. With the root declaring it, a
  // real `react-router build` and an SSR 200 both work inside a member — verified
  // by hand, because this suite has no network grant and so cannot run the npm
  // install that build needs.
  //
  // What it CAN check is everything up to the build: the member exists, the root
  // gained exactly one field, and the server-side modules type-check.
  it('adds a full-stack member and enables node_modules at the root', async () => {
    expect(await run(['new', 'shop', '--workspace', '--port', String(base)])).toBe(0);
    const ws = `${root}/shop`;
    expect(await run(['g', 'app', 'web', '--template', 'full-stack', '--dir', ws])).toBe(0);

    const rootManifest = JSON.parse(await Deno.readTextFile(`${ws}/deno.json`)) as {
      nodeModulesDir?: string;
      workspace?: string[];
      tasks?: Record<string, string>;
    };
    expect(rootManifest.nodeModulesDir).toBe('auto');
    // The merge keeps what the root already declared: a regenerated root would
    // drop the globs that make it a workspace at all.
    expect(rootManifest.workspace).toEqual(['./apps/*', './libs/*']);
    expect(rootManifest.tasks?.['dev']).toBe(
      'deno run --allow-read --allow-run --allow-net scripts/dev.ts',
    );

    // The route whose absence made `/` a blank 200 in every scaffolded
    // full-stack project. Asserted as a file because proving it functionally
    // needs the real build.
    const project = `${ws}/apps/web`;
    expect((await Deno.stat(`${project}/app/routes/_app/_index.tsx`)).isFile).toBe(true);

    await useWorkspacePackages(project);
    const { code, stderr } = await denoCheck(project, [
      `${project}/main.ts`,
      `${project}/setu.config.ts`,
      `${project}/app/lib/load-context.ts`,
    ]);
    expect(stderr).not.toContain('SyntaxError');
    expect(code).toBe(0);
  });

  // The whole claim of a library member is that it needs NO wiring: a Deno
  // workspace resolves a member by its declared name, so a sibling importing
  // `@acme/shared` resolves with no entry in its own import map and none in the
  // root's. Nothing but a real type-check of a member that imports one can prove
  // that — a unit test can only assert the manifest fields.
  it('lets a member import a generated library by name, with no import map entry', async () => {
    const ws = await twoMembers();
    expect(await run(['g', 'library', 'shared', '--dir', ws])).toBe(0);

    const project = `${ws}/apps/orders`;
    // The member's own manifest is NOT touched by the library command, which is
    // exactly what makes this test meaningful.
    const before = await Deno.readTextFile(`${project}/deno.json`);
    expect(before).not.toContain('@acme/shared');

    // A module in the member that imports the library and uses its export.
    await Deno.writeTextFile(
      `${project}/src/uses-library.ts`,
      `import { shared } from '@acme/shared';\n\n` +
        `export const describeIt = (): string => shared('orders');\n`,
    );

    await useWorkspacePackages(project);
    const { code, stderr } = await denoCheck(project, [`${project}/src/uses-library.ts`]);
    expect(stderr).not.toContain('Relative import path');
    expect(code).toBe(0);
  });

  // A member is a project like any other: `setu generate` reads ITS manifest,
  // so functional module output has to work inside one too.
  it('generates a functional module inside a member', async () => {
    const ws = await twoMembers();
    expect(await run(['g', 'module', 'invoice', '--dir', `${ws}/apps/billing`])).toBe(0);
    expect(
      (await Deno.stat(`${ws}/apps/billing/src/controllers/invoice.routes.ts`)).isFile,
    ).toBe(true);
  });

  it('resolves and calls a sibling through the discovery capability', async () => {
    const ws = await twoMembers();
    for (const member of ['orders', 'billing']) {
      await useWorkspacePackages(`${ws}/apps/${member}`);
    }

    // `billing` is a real server on the port the CLI allocated it, started
    // through its own generated entry — so the port under test is the one the
    // member actually binds, not one this test chose.
    const server = new Deno.Command(Deno.execPath(), {
      args: ['run', '-A', '--node-modules-dir=none', 'main.ts'],
      cwd: `${ws}/apps/billing`,
      stdout: 'piped',
      stderr: 'piped',
    }).spawn();

    try {
      const result = await bootAndProbe(`${ws}/apps/orders`, RESOLVE_PROBE);

      expect(result['instances']).toEqual([{ host: '127.0.0.1', port: base + 1 }]);
      expect(result['url']).toBe(`http://127.0.0.1:${base + 1}/`);
      // The map excludes the member itself, so its own name resolves to nothing.
      expect(result['self']).toEqual([]);
      // The request arrived: the generated map and the sibling's binding agree.
      expect(result['status']).toBe(200);
      expect(String(result['body'])).toContain('Hello, World!');
    } finally {
      server.kill();
      await server.status;
      // The piped streams keep the subprocess resource alive until they close.
      await server.stdout.cancel();
      await server.stderr.cancel();
    }
  });
});
