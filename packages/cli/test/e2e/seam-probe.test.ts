/**
 * The functional bar: a scaffolded project is booted and every wired artifact is
 * observed doing its job.
 *
 * This is the check the milestone exists for. `setu g controller` shipped broken from
 * M34 through five releases — every controller it emitted answered `500`, because
 * `DecoratorPlugin` builds a handler's arguments from parameter metadata alone while the
 * template expected the context positionally. `deno check` passed the whole time and the
 * unit test asserted the broken import was PRESENT. **Compiling is not working.**
 *
 * One boot per host template carrying EVERY artifact, rather than one boot per artifact:
 * eleven subprocess boots of a workspace-source project would add minutes to the suite,
 * and a single booted app carrying all of them is the stronger proof — it shows they
 * coexist, which eleven isolated boots would not.
 *
 * @module
 */

import { afterEach, beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createDenoRuntimeServices } from '@setu-ts/runtime';
import type { IFileSystem } from '@setu-ts/common';
import { runCli } from '../../src/cli.ts';

const runtime = createDenoRuntimeServices();
const fs: IFileSystem = runtime.fs!;

/** This repository's root, four levels up from `packages/cli/test/e2e/`. */
const REPO_ROOT = new URL('../../../../', import.meta.url).pathname.replace(/\/$/, '');

/** Starter packages live one directory deeper than every other package. */
const STARTER_PACKAGES: ReadonlySet<string> = new Set([
  'rest-starter',
  'microservice-starter',
  'full-stack-starter',
]);

/**
 * The workspace's own compiler options, applied before a scaffolded project is booted.
 *
 * Repointing at workspace SOURCE means the framework is compiled too, and it only
 * compiles under the settings it was written against — `exactOptionalPropertyTypes`
 * above all.
 */
const WORKSPACE_COMPILER_OPTIONS: Readonly<Record<string, boolean>> = {
  strict: true,
  noUnusedLocals: true,
  noUnusedParameters: true,
  noImplicitReturns: true,
  noFallthroughCasesInSwitch: true,
  noImplicitOverride: true,
  exactOptionalPropertyTypes: true,
  useUnknownInCatchVariables: true,
};

/**
 * Repoints a scaffolded project's `@setu-ts/*` imports at this workspace.
 *
 * @param root - The project directory
 */
async function useWorkspacePackages(root: string): Promise<void> {
  const manifestPath = `${root}/deno.json`;
  const manifest = JSON.parse(await Deno.readTextFile(manifestPath)) as {
    imports?: Record<string, string>;
    compilerOptions?: Record<string, unknown>;
  };
  const imports: Record<string, string> = {};
  for (const [specifier, target] of Object.entries(manifest.imports ?? {})) {
    if (!specifier.startsWith('@setu-ts/')) {
      imports[specifier] = target;
      continue;
    }
    const pkg = specifier.slice('@setu-ts/'.length);
    const dir = STARTER_PACKAGES.has(pkg) ? `packages/starters/${pkg}` : `packages/${pkg}`;
    imports[specifier] = `${REPO_ROOT}/${dir}/src/index.ts`;
  }
  manifest.imports = imports;
  manifest.compilerOptions = { ...manifest.compilerOptions, ...WORKSPACE_COMPILER_OPTIONS };
  await Deno.writeTextFile(manifestPath, JSON.stringify(manifest, null, 2));
}

/** Prefix the probe puts its one-line JSON result behind. */
const PROBE_MARKER = '__PROBE_RESULT__';

/**
 * Boots a scaffolded project in a subprocess and returns the probe's JSON.
 *
 * A subprocess rather than an in-process import: the project resolves `@setu-ts/*`
 * through its own manifest, and running it here would load a second copy of the
 * framework into this test process.
 *
 * @param project - The project directory, already repointed at the workspace
 * @param probe - The probe module source, written into the project
 * @returns The parsed JSON the probe printed
 */
async function bootAndProbe(project: string, probe: string): Promise<Record<string, unknown>> {
  await Deno.writeTextFile(`${project}/run-probe.ts`, probe);
  const command = new Deno.Command(Deno.execPath(), {
    args: [
      'run',
      '-A',
      '--node-modules-dir=none',
      '--config',
      `${project}/deno.json`,
      `${project}/run-probe.ts`,
    ],
    stdout: 'piped',
    stderr: 'piped',
  });
  const { code, stdout, stderr } = await command.output();
  const out = new TextDecoder().decode(stdout);
  if (code !== 0) {
    throw new Error(`probe exited ${code}\n${new TextDecoder().decode(stderr)}`);
  }
  // The booted app logs its own JSON lines to stdout, so the result is carried on ONE
  // line behind a marker rather than located by shape.
  const line = out.split('\n').find((l) => l.startsWith(PROBE_MARKER));
  if (line === undefined) throw new Error(`probe printed no result:\n${out}`);
  return JSON.parse(line.slice(PROBE_MARKER.length)) as Record<string, unknown>;
}

/**
 * Artifacts generated into every host, with DISTINCT names inside each collision group.
 *
 * `route`, `controller` and `module` all mount `/<name>`, and `service` and `module` both
 * claim `<name>-service` — so sharing one name here would exercise the collision guard
 * instead of the wiring. Two names per family, to prove the barrel unions rather than
 * replaces.
 */
const ARTIFACTS: readonly (readonly [schematic: string, name: string])[] = [
  ['route', 'widget-route'],
  ['route', 'gadget-route'],
  ['controller', 'widget-ctl'],
  ['module', 'widget-mod'],
  ['service', 'widget-svc'],
  ['service', 'gadget-svc'],
  ['middleware', 'widget'],
  ['plugin', 'widget'],
  ['plugin', 'gadget'],
  ['health-indicator', 'widget'],
  ['health-indicator', 'gadget'],
  ['metric', 'widget'],
  ['metric', 'gadget'],
];

/** The CQRS and events artifacts, which only the microservice template can host. */
const MICROSERVICE_ONLY: readonly (readonly [schematic: string, name: string])[] = [
  ['command-handler', 'widget'],
  ['query-handler', 'widget'],
  ['event-handler', 'widget'],
];

/**
 * The probe shared by both hosts.
 *
 * Every assertion reads through a real request or the real service registry — never the
 * emitted source — so a barrel that compiles but registers nothing fails here.
 */
const PROBE = `import { CAPABILITIES } from '@setu-ts/common';
import type { IServiceRegistry } from '@setu-ts/common';
import { createApp } from './setu.config.ts';

const app = await createApp();
await app.start();
const services: IServiceRegistry = app.services;
const out: Record<string, unknown> = {};

const read = async (url: string) => {
  const r = await app.fetch(new Request(url));
  return { status: r.status, body: await r.text(), widgetHeader: r.headers.get('x-widget') };
};

// route: the generated route group answers. middleware: its header is on that response.
const routed = await read('http://x/widget-route/');
out['route'] = { status: routed.status, body: routed.body };
out['middlewareHeader'] = routed.widgetHeader;

// controller and module: both decorated classes are registered and reachable.
const ctl = await read('http://x/widget-ctl');
out['controller'] = { status: ctl.status, body: ctl.body };
const mod = await read('http://x/widget-mod');
out['module'] = { status: mod.status, body: mod.body };

// service: the @Injectable landed in the registry under its token.
out['serviceToken'] = services.get<{ describe(): string }>('widget-svc-service').describe();

// plugin: the generated plugin registered its own capability token.
out['pluginToken'] = services.get<{ describe(): string }>('widget').describe();

// health-indicator: both appear in the aggregated report.
const health = await read('http://x/health');
out['healthChecks'] = Object.keys(
  (JSON.parse(health.body) as { checks?: Record<string, unknown> }).checks ?? {},
).sort();

// metric: pre-registered, so it is declared before anything samples it.
const metrics = await read('http://x/metrics');
out['metricDeclared'] = metrics.body.includes('# TYPE widget_total counter');
out['metricSampled'] = /^widget_total/m.test(metrics.body);

__CQRS__

console.log('__PROBE_RESULT__' + JSON.stringify(out));
await app.stop();
`;

/** The CQRS and events half of the probe, appended for the microservice host only. */
const CQRS_PROBE = `
const cqrs = services.get<import('@setu-ts/common').ICqrsFacade>(CAPABILITIES.CQRS);
const { WIDGET_COMMAND } = await import('./src/cqrs/widget.command-handler.ts');
const { WIDGET_QUERY } = await import('./src/cqrs/widget.query-handler.ts');
const { WIDGET_EVENT } = await import('./src/events/widget.event-handler.ts');
out['commandResult'] = await cqrs.commandBus.execute({
  type: WIDGET_COMMAND,
  data: { id: 'c-1' },
});
out['queryResult'] = await cqrs.queryBus.execute({ type: WIDGET_QUERY, data: { id: 'q-1' } });

const seen: string[] = [];
const bus = services.get<import('@setu-ts/common').IEventBus>(CAPABILITIES.EVENTS);
bus.subscribe(WIDGET_EVENT, () => void seen.push('observer'));
await bus.publish({
  type: WIDGET_EVENT,
  data: { id: 'e-1' },
  id: 'evt-1',
  occurredAt: new Date().toISOString(),
});
// The generated handler resolves without throwing, and the plugin's own health indicator
// reports it — the observer above proves the bus itself delivered.
out['eventDelivered'] = seen.length === 1;
out['eventSubscriptions'] =
  (JSON.parse(health.body) as { checks?: Record<string, { data?: { handlers?: number } }> })
    .checks?.events?.data?.handlers ?? 0;
`;

describe('generated artifacts are wired — end to end', () => {
  let root: string;
  let out: string[];
  let err: string[];

  const run = (argv: readonly string[]) =>
    runCli(argv, {
      fs,
      cwd: root,
      now: () => runtime.now(),
      log: (m) => out.push(m),
      error: (m) => err.push(m),
    });

  beforeEach(async () => {
    root = await Deno.makeTempDir({ prefix: 'setu-seam-' });
    out = [];
    err = [];
  });

  afterEach(async () => {
    await Deno.remove(root, { recursive: true });
  });

  for (const template of ['rest', 'microservice'] as const) {
    it(`serves every wired artifact on --template ${template}`, async () => {
      expect(await run(['new', 'shop', '--template', template])).toBe(0);
      const project = `${root}/shop`;

      const wanted = template === 'microservice' ? [...ARTIFACTS, ...MICROSERVICE_ONLY] : ARTIFACTS;
      for (const [schematic, name] of wanted) {
        expect(await run(['g', schematic, name, '--dir', project])).toBe(0);
      }

      await useWorkspacePackages(project);
      const probe = PROBE.replace('__CQRS__', template === 'microservice' ? CQRS_PROBE : '');
      const result = await bootAndProbe(project, probe);

      // The generated route module was called with `app.router` from `createApp()`.
      expect(result['route']).toEqual({ status: 200, body: '{"items":[]}' });
      // The generated middleware was added, and ran — its header is on that response.
      expect(result['middlewareHeader']).toBe('true');
      // The standalone controller reached DecoratorPlugin through its own barrel.
      expect(result['controller']).toEqual({ status: 200, body: '{"items":[]}' });
      // And the M58 module barrel still works beside the new seams.
      expect(result['module']).toEqual({ status: 200, body: '{"items":[]}' });
      // The @Injectable service resolves under the token its own JSDoc names.
      expect(result['serviceToken']).toBe('widget-svc');
      // The generated plugin registered its capability token.
      expect(result['pluginToken']).toBe('widget');
      // Both indicators were handed to HealthPlugin({ indicators }).
      expect(result['healthChecks']).toContain('widget');
      expect(result['healthChecks']).toContain('gadget');
      // The metric is DECLARED at boot and has no sample — which is the whole point of
      // pre-registration, and is why a `# TYPE` check rather than a value check is right.
      expect(result['metricDeclared']).toBe(true);
      expect(result['metricSampled']).toBe(false);

      if (template === 'microservice') {
        // Both buses route to the generated handlers, through the new plugin options.
        expect(result['commandResult']).toEqual({ id: 'c-1' });
        expect(result['queryResult']).toEqual({ id: 'q-1' });
        expect(result['eventDelivered']).toBe(true);
        // Exactly one subscription, and it is the generated handler: the observer the
        // probe adds is subscribed AFTER /health is read.
        expect(result['eventSubscriptions']).toBe(1);
      }
    });
  }

  // A project that generated a middleware or a metric BEFORE that artifact gained its
  // second export has the right filename and the wrong exports. The barrel is
  // regenerated from a directory scan, so it used to name a symbol the old file did not
  // have — `deno check` then failed on a file the CLI had just reported creating.
  //
  // Checked with a real `deno check` rather than a string assertion, because the failure
  // was a type error in the developer's project, which is the only place it shows up.
  describe("an artifact predating its family's second export", () => {
    /** The pre-seam middleware shape: the factory only, no priority constant. */
    const OLD_MIDDLEWARE = `import type { MiddlewareFunction } from '@setu-ts/common';

export function auditLogMiddleware(): MiddlewareFunction {
  return async (ctx, next) => {
    await next();
    void ctx;
  };
}
`;

    it('leaves the regenerated barrel compiling', async () => {
      expect(await run(['new', 'shop', '--template', 'rest'])).toBe(0);
      const project = `${root}/shop`;
      await Deno.mkdir(`${project}/src/middleware`, { recursive: true });
      await Deno.writeTextFile(
        `${project}/src/middleware/audit-log.middleware.ts`,
        OLD_MIDDLEWARE,
      );

      err = [];
      expect(await run(['g', 'middleware', 'request-id', '--dir', project])).toBe(0);

      // Reported, not silently dropped.
      expect(err.join('\n')).toContain('audit-log.middleware.ts');
      expect(err.join('\n')).toContain('AUDIT_LOG_MIDDLEWARE_PRIORITY');

      await useWorkspacePackages(project);
      const barrel = `${project}/src/middleware/index.ts`;
      const command = new Deno.Command(Deno.execPath(), {
        args: ['check', '--node-modules-dir=none', '--config', `${project}/deno.json`, barrel],
        stdout: 'piped',
        stderr: 'piped',
      });
      const { code, stderr } = await command.output();
      const output = new TextDecoder().decode(stderr);

      // Without the scanner's export check this is TS2305: "has no exported member
      // 'AUDIT_LOG_MIDDLEWARE_PRIORITY'".
      expect(output).not.toContain('TS2305');
      expect(code).toBe(0);
    });
  });

  // The wiring is what makes these collisions real: before the seams, two artifacts
  // sharing a name were two inert files. Both refusals below were derived from observed
  // failures — a 500 on every module request, and a silently unreachable route.
  describe('the collision refusal', () => {
    it('refuses each colliding pair, and writes nothing', async () => {
      expect(await run(['new', 'shop', '--template', 'rest'])).toBe(0);
      const project = `${root}/shop`;
      expect(await run(['g', 'module', 'widget', '--dir', project])).toBe(0);
      expect(await run(['g', 'controller', 'gizmo', '--dir', project])).toBe(0);

      // A service would claim the module's injection token.
      err = [];
      expect(await run(['g', 'service', 'widget', '--dir', project])).toBe(1);
      expect(err.join('\n')).toContain("the injection token 'widget-service'");
      await expect(Deno.stat(`${project}/src/services/widget.service.ts`)).rejects.toThrow();

      // A route would claim the controller's HTTP path.
      err = [];
      expect(await run(['g', 'route', 'gizmo', '--dir', project])).toBe(1);
      expect(err.join('\n')).toContain('the HTTP path /gizmo');
      await expect(Deno.stat(`${project}/src/routes/gizmo.routes.ts`)).rejects.toThrow();

      // A free name still works, so the guard is not blanket.
      expect(await run(['g', 'service', 'unrelated', '--dir', project])).toBe(0);
    });
  });
});
