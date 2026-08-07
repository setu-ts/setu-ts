/**
 * The drift gate: scaffolds each template into a REAL temp directory, generates
 * over the §6.1 hostile name set, and runs `deno check` on the result.
 *
 * A gate that exercises one input proves one input — M34's version ran only
 * `order-item` and still shipped `(class) => {` and `class 2faService`, both
 * unparseable.
 *
 * The check resolves `@setu-ts/*` to THIS workspace, not to JSR. That
 * is both more correct and necessary:
 *
 * - More correct: drift means "the template disagrees with the framework as it
 *   is now". Checking against a published snapshot would pass a template that
 *   is stale relative to HEAD, and fail one correctly updated for an unreleased
 *   API change.
 * - Necessary: `setu new` pins generated projects to the CLI's OWN version, so
 *   during a version bump the pinned version is not published yet. Checking
 *   against JSR would deadlock — the release workflow runs the test suite
 *   BEFORE publishing, so the gate would block the publish that would fix it.
 *
 * @module
 */

import { afterEach, beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createDenoRuntimeServices } from '@setu-ts/runtime';
import type { IFileSystem } from '@setu-ts/common';
import { runCli } from '../../src/cli.ts';
import { listTemplates } from '../../src/templates/registry.ts';

const runtime = createDenoRuntimeServices();
const fs: IFileSystem = runtime.fs!;

/**
 * Names generation must survive. Each entry names the defect it guards.
 */
const HOSTILE_NAMES: readonly { readonly name: string; readonly accepted: boolean }[] = [
  { name: 'order-item', accepted: true }, // the ordinary multi-word path
  { name: 'class', accepted: true }, // reserved word — M34 emitted `(class) => {`
  { name: 'new', accepted: true }, // reserved word that is also a CLI verb
  { name: 'API', accepted: true }, // all-caps segment → Pascal `Api`
  { name: 'oauth2-client', accepted: true }, // digits inside a word
  { name: 'user', accepted: true }, // single word
  { name: '2fa', accepted: false }, // digit-leading — refused, never emitted
];

/**
 * Schematics that need no plugin installed, so the hostile-name sweep runs
 * against a bare project. `controller` is absent: it is gated on
 * `decorator-plugin`, and is covered by the rest-template check below.
 */
const UNGATED = ['plugin', 'service', 'route', 'middleware', 'job'] as const;

/** Every schematic the `rest` template's plugin set makes available. */
const REST_AVAILABLE = [...UNGATED, 'controller'] as const;

/** This repository's root, four levels up from `packages/cli/test/e2e/`. */
const REPO_ROOT = new URL('../../../../', import.meta.url).pathname.replace(/\/$/, '');

/**
 * Repoints a scaffolded project's `@setu-ts/*` imports at this
 * workspace, so the check measures drift against HEAD rather than against a
 * published snapshot.
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
    // Only framework specifiers are repointed. A template may also declare a
    // project-local alias (`~/` → `./app/`), and rewriting that to a package
    // path would break every module that imports through it.
    if (!specifier.startsWith('@setu-ts/')) {
      imports[specifier] = target;
      continue;
    }
    imports[specifier] = workspaceEntrypoint(specifier.slice('@setu-ts/'.length));
  }
  manifest.imports = imports;
  manifest.compilerOptions = { ...manifest.compilerOptions, ...WORKSPACE_COMPILER_OPTIONS };
  await Deno.writeTextFile(manifestPath, JSON.stringify(manifest, null, 2));
}

/** Starter packages live one directory deeper than every other package. */
const STARTER_PACKAGES: ReadonlySet<string> = new Set([
  'rest-starter',
  'microservice-starter',
  'full-stack-starter',
]);

/**
 * Maps a bare package name to its entrypoint in this workspace.
 *
 * @param pkg - The package name without the scope
 * @returns The absolute path to its `src/index.ts`
 */
function workspaceEntrypoint(pkg: string): string {
  const dir = STARTER_PACKAGES.has(pkg) ? `packages/starters/${pkg}` : `packages/${pkg}`;
  return `${REPO_ROOT}/${dir}/src/index.ts`;
}

/**
 * Runs `deno check` over a scaffolded project.
 *
 * @param root - The project directory
 * @param files - Files to check
 * @returns The process result
 */
async function denoCheck(root: string, files: readonly string[]) {
  const command = new Deno.Command(Deno.execPath(), {
    // `--node-modules-dir=none` because a template that also emits a
    // package.json (a frontend build) would otherwise switch Deno into
    // node_modules resolution, and the gate must not run an npm install to
    // type-check generated TypeScript.
    args: ['check', '--node-modules-dir=none', '--config', `${root}/deno.json`, ...files],
    stdout: 'piped',
    stderr: 'piped',
  });
  const { code, stderr } = await command.output();
  return { code, stderr: new TextDecoder().decode(stderr) };
}

/**
 * The workspace's own compiler options, applied to a scaffolded project before
 * it is checked.
 *
 * Repointing at workspace SOURCE means the framework is type-checked too, and
 * it only compiles under the settings it was written against —
 * `exactOptionalPropertyTypes` above all. Without this, checking a project
 * whose import graph reaches far enough into the workspace fails inside
 * framework source rather than in anything the template emitted.
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

describe('template scaffolding — end to end', () => {
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
    root = await Deno.makeTempDir({ prefix: 'setu-tpl-' });
    out = [];
    err = [];
  });

  afterEach(async () => {
    await Deno.remove(root, { recursive: true });
  });

  for (const template of listTemplates()) {
    it(`scaffolds a ${template.name} project whose files exist on disk`, async () => {
      expect(await run(['new', 'svc', '--template', template.name])).toBe(0);
      for (const name of ['deno.json', 'main.ts', 'setu.config.ts', 'README.md']) {
        expect((await Deno.stat(`${root}/svc/${name}`)).isFile).toBe(true);
      }
    });

    it(`emits a ${template.name} config declaring every plugin in the manifest`, async () => {
      await run(['new', 'svc', '--template', template.name]);
      const config = await Deno.readTextFile(`${root}/svc/setu.config.ts`);
      const manifest = JSON.parse(await Deno.readTextFile(`${root}/svc/deno.json`));
      for (const match of config.matchAll(/from '(@setu-ts\/[a-z-]+)'/g)) {
        expect(Object.keys(manifest.imports)).toContain(match[1]);
      }
    });
  }

  it('refuses a controller in a project without the decorator plugin', async () => {
    // Regression: the schematic emits @Controller/@Get/@Post, so an ungated
    // generate produced source whose own import could not resolve.
    await run(['new', 'bare']);
    expect(await run(['g', 'controller', 'user', '--dir', `${root}/bare`])).toBe(1);
    expect(err.join('\n')).toContain('@setu-ts/decorator-plugin');
  });

  it('allows a controller once the rest template installs the decorator plugin', async () => {
    await run(['new', 'svc', '--template', 'rest']);
    expect(await run(['g', 'controller', 'user', '--dir', `${root}/svc`])).toBe(0);
  });

  describe('the hostile name set', () => {
    for (const { name, accepted } of HOSTILE_NAMES) {
      it(`${accepted ? 'generates' : 'refuses'} the name "${name}"`, async () => {
        await run(['new', 'svc']);
        const project = `${root}/svc`;
        for (const schematic of UNGATED) {
          const code = await run(['g', schematic, name, '--dir', project]);
          expect(code).toBe(accepted ? 0 : 2);
        }
      });
    }

    it('never writes a file for a refused name', async () => {
      await run(['new', 'svc']);
      const project = `${root}/svc`;
      expect(await run(['g', 'service', '2fa', '--dir', project])).toBe(2);
      await expect(Deno.stat(`${project}/src/services`)).rejects.toThrow();
    });
  });

  // The `nest` template is the only one whose config imports project-local
  // modules, and one of two carrying an `args` string (see the `microservice`
  // case below). Both are rendered source that nothing else validates: an
  // `args` string naming an undeclared identifier, or a `localImports` path
  // that does not resolve, type-checks nowhere else in the suite. This is that
  // check.
  it('type-checks the scaffolded nest project, including its emitted classes', async () => {
    expect(await run(['new', 'svc', '--template', 'nest'])).toBe(0);
    const project = `${root}/svc`;

    const sources = [
      `${project}/main.ts`,
      `${project}/setu.config.ts`,
      `${project}/src/greeting-service.ts`,
      `${project}/src/greeting-controller.ts`,
    ];
    for (const source of sources) {
      expect((await Deno.stat(source)).isFile).toBe(true);
    }

    await useWorkspacePackages(project);
    const { code, stderr } = await denoCheck(project, sources);
    expect(stderr).not.toContain('SyntaxError');
    expect(code).toBe(0);
  });

  // The `microservice` template had no e2e coverage at all until service
  // discovery was wired into it, and it is now the only template whose `args`
  // string is an option OBJECT checked against a discriminated union.
  // `ServiceDiscoveryPluginOptions` has no default arm, so a wrong discriminant
  // or a misspelled field is a compile error in the GENERATED project and
  // nowhere else — `args` is an opaque string literal as far as the CLI's own
  // `deno check` is concerned.
  it('type-checks the scaffolded microservice project, including the discovery args', async () => {
    expect(await run(['new', 'msvc', '--template', 'microservice'])).toBe(0);
    const project = `${root}/msvc`;

    const config = await Deno.readTextFile(`${project}/setu.config.ts`);
    expect(config).toContain(
      "ServiceDiscoveryPlugin({ provider: 'static', services: {} })",
    );

    const sources = [`${project}/main.ts`, `${project}/setu.config.ts`];
    await useWorkspacePackages(project);
    const { code, stderr } = await denoCheck(project, sources);
    expect(stderr).not.toContain('SyntaxError');
    expect(code).toBe(0);
  });

  // The full-stack template is the only one that composes through a starter
  // factory, renders a runtime-dependent argument, and emits an app tree whose
  // modules import each other through an alias. None of that is validated
  // anywhere else: a factory call disagreeing with the starter's real
  // signature, or an alias the manifest never declares, type-checks nowhere
  // else in the suite.
  it('type-checks the scaffolded full-stack project, config and app tree', async () => {
    expect(await run(['new', 'shop', '--template', 'full-stack'])).toBe(0);
    const project = `${root}/shop`;

    // The .tsx files are deliberately excluded: they need React and the npm
    // toolchain the project installs, which CI does not run. Everything with
    // framework coupling is plain TypeScript and IS checked.
    const sources = [
      `${project}/main.ts`,
      `${project}/setu.config.ts`,
      `${project}/app/lib/context-keys.server.ts`,
      `${project}/app/lib/load-context.ts`,
      `${project}/app/config/services.server.ts`,
      `${project}/app/models/product.ts`,
      `${project}/app/services/products.server.ts`,
      `${project}/app/features/products/products.server.ts`,
    ];
    for (const source of sources) {
      expect((await Deno.stat(source)).isFile).toBe(true);
    }

    await useWorkspacePackages(project);
    const { code, stderr } = await denoCheck(project, sources);
    expect(stderr).not.toContain('SyntaxError');
    expect(code).toBe(0);
  });

  it('serves static assets everywhere but Cloudflare Workers', async () => {
    // The one runtime-dependent value in the template. On Workers a missing
    // filesystem would make the asset handler answer 404 for every asset, so
    // the option is omitted and no asset route is registered at all.
    expect(await run(['new', 'shop', '--template', 'full-stack', '--runtime', 'deno'])).toBe(0);
    expect(
      await run(['new', 'edge', '--template', 'full-stack', '--runtime', 'cloudflare-workers']),
    ).toBe(0);

    const deno = await Deno.readTextFile(`${root}/shop/setu.config.ts`);
    const workers = await Deno.readTextFile(`${root}/edge/setu.config.ts`);

    expect(deno).toContain("assetsDir: './build/client/assets'");
    expect(workers).not.toContain('assetsDir');
    // The rest of the wiring is identical, so the difference is the asset
    // option and nothing else.
    expect(workers).toContain("new URL('./build/server/index.js', import.meta.url).href");
  });

  it('emits the npm toolchain on a Deno target, which has no package.json of its own', async () => {
    expect(await run(['new', 'shop', '--template', 'full-stack', '--runtime', 'deno'])).toBe(0);
    const manifest = JSON.parse(await Deno.readTextFile(`${root}/shop/package.json`));

    // The frontend build runs on npm even when the server runs on Deno — the
    // one documented exception to the Deno-only toolchain.
    expect(manifest.devDependencies['@react-router/dev']).toBeDefined();
    expect(manifest.devDependencies['vite']).toBeDefined();
    // Framework packages resolve through the Deno import map, never here.
    expect(Object.keys(manifest.devDependencies)).not.toContain('@setu-ts/kernel');
    expect(Object.keys(manifest.dependencies ?? {})).not.toContain('@setu-ts/kernel');
  });

  it('merges the npm toolchain into the fixed manifest on a Node target', async () => {
    expect(await run(['new', 'shop', '--template', 'full-stack', '--runtime', 'node'])).toBe(0);
    const manifest = JSON.parse(await Deno.readTextFile(`${root}/shop/package.json`));

    // One package.json carrying both: a second file would collide with the
    // fixed set and silently overwrite the framework dependencies.
    expect(manifest.dependencies['@setu-ts/full-stack-starter']).toBeDefined();
    expect(manifest.devDependencies['@react-router/dev']).toBeDefined();

    const tsconfig = JSON.parse(await Deno.readTextFile(`${root}/shop/tsconfig.json`));
    expect(tsconfig.compilerOptions.paths['~/*']).toEqual(['./app/*']);
    // The fixed options survive the merge.
    expect(tsconfig.compilerOptions.strict).toBe(true);
  });

  it('grants the Deno start task the read permission SSR needs', async () => {
    expect(await run(['new', 'shop', '--template', 'full-stack'])).toBe(0);
    const manifest = JSON.parse(await Deno.readTextFile(`${root}/shop/deno.json`));

    // Without it the project scaffolds, starts, and fails on its first request:
    // the SSR plugin imports its own server build and reads client assets.
    expect(manifest.tasks.start).toContain('--allow-read');
    expect(manifest.imports['~/']).toBe('./app/');
  });

  it('emits no hello-world route, which would shadow the SSR index', async () => {
    expect(await run(['new', 'shop', '--template', 'full-stack'])).toBe(0);
    const config = await Deno.readTextFile(`${root}/shop/setu.config.ts`);

    // An exact '/' handler beats the catch-all the SSR plugin mounts, so the
    // app's own index route would never render.
    expect(config).not.toContain("app.router.get('/'");
    expect(config).not.toContain('createApplication');
  });

  it('wires the nest config with DI and the emitted classes', async () => {
    expect(await run(['new', 'svc', '--template', 'nest'])).toBe(0);
    const config = await Deno.readTextFile(`${root}/svc/setu.config.ts`);

    // The args string, rendered into the plugin call.
    expect(config).toContain(
      'DecoratorPlugin({ controllers: [GreetingController], services: [GreetingService] })',
    );
    // DiPlugin is what puts @Injectable classes on the container path.
    expect(config).toContain('DiPlugin()');
    // The local imports that bring the args identifiers into scope.
    expect(config).toContain("from './src/greeting-controller.ts'");
    expect(config).toContain("from './src/greeting-service.ts'");
  });

  it('emits parameter-level @Inject in the nest controller', async () => {
    expect(await run(['new', 'svc', '--template', 'nest'])).toBe(0);
    const controller = await Deno.readTextFile(`${root}/svc/src/greeting-controller.ts`);
    // The showcase is the parameter position, not the deprecated class-level list.
    expect(controller).toContain("@Inject('greeting-service')");
    expect(controller).not.toContain("@Inject('greeting-service')\n@Controller");
  });

  it('accepts the nest template on every runtime target', async () => {
    // `unsupported` is empty — nothing in the template needs raw sockets.
    for (const target of ['deno', 'node', 'bun', 'cloudflare-workers']) {
      out = [];
      err = [];
      expect(await run(['new', `svc-${target}`, '--template', 'nest', '--runtime', target])).toBe(
        0,
      );
    }
  });

  it('type-checks a scaffolded project generated over every accepted name', async () => {
    expect(await run(['new', 'svc', '--template', 'rest'])).toBe(0);
    const project = `${root}/svc`;

    for (const { name, accepted } of HOSTILE_NAMES) {
      if (!accepted) continue;
      for (const schematic of REST_AVAILABLE) {
        expect(await run(['g', schematic, name, '--dir', project])).toBe(0);
      }
    }

    const sources: string[] = [`${project}/main.ts`, `${project}/setu.config.ts`];
    for await (const entry of Deno.readDir(`${project}/src`)) {
      for await (const file of Deno.readDir(`${project}/src/${entry.name}`)) {
        sources.push(`${project}/src/${entry.name}/${file.name}`);
      }
    }
    // one file per schematic × accepted name, plus the two entry files.
    const accepted = HOSTILE_NAMES.filter((n) => n.accepted).length;
    expect(sources.length).toBe(REST_AVAILABLE.length * accepted + 2);

    await useWorkspacePackages(project);
    const { code, stderr } = await denoCheck(project, sources);
    expect(stderr).not.toContain('SyntaxError');
    expect(code).toBe(0);
  });
});
