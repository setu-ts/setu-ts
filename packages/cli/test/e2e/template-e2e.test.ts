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

/**
 * Every single-file schematic the `rest` template's plugin set makes available.
 *
 * `module` is excluded here and swept separately: it is the one aggregate, so it
 * emits four files per name plus one shared barrel rather than one file, and
 * folding it in would make the file-count arithmetic below unreadable.
 */
const REST_AVAILABLE = [...UNGATED, 'controller'] as const;

/**
 * Files the `module` schematic emits per name, all of which the drift check
 * reads.
 *
 * The emitted `*.service.test.ts` is INCLUDED deliberately. Excluding it is what
 * hid a real defect: the test imports `@std/testing/bdd` and `@std/expect`, and
 * until the host templates declared those specifiers, the first `deno test` in a
 * scaffolded project failed. A gate that skips the generated file it is least
 * sure about is a gate written around the bug.
 */
const MODULE_FILES_PER_NAME = 4;

/**
 * Collects every `.ts` source under a directory, recursively.
 *
 * Recursive because `src/modules/` holds the aggregate barrel BESIDE the module
 * directories, so a fixed two-level walk would try to read a file as a directory.
 *
 * Every `.ts` file is collected, test files included — a generated test whose own
 * imports do not resolve is a defect in what the CLI emitted, so the gate has to
 * see it.
 *
 * @param dir - Directory to walk
 * @returns Absolute paths of the `.ts` files found
 */
async function collectSources(dir: string): Promise<string[]> {
  const found: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory) {
      found.push(...(await collectSources(path)));
    } else if (entry.name.endsWith('.ts')) {
      found.push(path);
    }
  }
  return found;
}

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

    // The args string, rendered into the plugin call. The showcase classes come
    // first, then the module barrel is spread, so `setu g module` adds to this
    // registration rather than replacing it.
    expect(config).toContain(
      'DecoratorPlugin({ controllers: [GreetingController, ...MODULE_CONTROLLERS], ' +
        'services: [GreetingService, ...MODULE_SERVICES] })',
    );
    // DiPlugin is what puts @Injectable classes on the container path.
    expect(config).toContain('DiPlugin()');
    // The local imports that bring the args identifiers into scope.
    expect(config).toContain("from './src/greeting-controller.ts'");
    expect(config).toContain("from './src/greeting-service.ts'");
    expect(config).toContain("from './src/modules/index.ts'");
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
      for (const schematic of [...REST_AVAILABLE, 'module']) {
        expect(await run(['g', schematic, name, '--dir', project])).toBe(0);
      }
    }

    const sources: string[] = [
      `${project}/main.ts`,
      `${project}/setu.config.ts`,
      ...(await collectSources(`${project}/src`)),
    ];
    // One file per single-file schematic × accepted name; the module aggregate
    // adds its own per-name files plus the ONE shared barrel; plus two entries.
    const accepted = HOSTILE_NAMES.filter((n) => n.accepted).length;
    expect(sources.length).toBe(
      REST_AVAILABLE.length * accepted + MODULE_FILES_PER_NAME * accepted + 1 + 2,
    );

    await useWorkspacePackages(project);
    const { code, stderr } = await denoCheck(project, sources);
    expect(stderr).not.toContain('SyntaxError');
    expect(code).toBe(0);
  });
});

// The module schematic's whole point is that the generated module is WIRED, and
// the wiring travels through a `Wiring.args` string plus a generated barrel —
// neither of which the CLI's own `deno check` can see. Only a scaffolded,
// type-checked project proves the barrel's exports, the config's import of them,
// and the controller's `@Inject` all agree.
describe('setu generate module, end to end', () => {
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
    root = await Deno.makeTempDir({ prefix: 'setu-module-e2e-' });
    out = [];
    err = [];
  });

  afterEach(async () => {
    await Deno.remove(root, { recursive: true });
  });

  /**
   * Collects every generated module source in a project.
   *
   * @param project - The project directory
   * @returns Absolute paths, including the aggregate barrel
   */
  async function moduleSources(project: string): Promise<string[]> {
    const paths: string[] = [`${project}/src/modules/index.ts`];
    for await (const entry of Deno.readDir(`${project}/src/modules`)) {
      if (!entry.isDirectory) continue;
      for await (const file of Deno.readDir(`${project}/src/modules/${entry.name}`)) {
        // Test files included: the host templates declare the `@std` specifiers
        // the emitted test imports, so it must type-check like any other file.
        paths.push(`${project}/src/modules/${entry.name}/${file.name}`);
      }
    }
    return paths;
  }

  it('type-checks a rest project carrying two generated modules', async () => {
    expect(await run(['new', 'shop', '--template', 'rest'])).toBe(0);
    const project = `${root}/shop`;

    expect(await run(['g', 'module', 'user', '--dir', project])).toBe(0);
    expect(await run(['g', 'module', 'order-item', '--dir', project])).toBe(0);

    // The barrel names both modules — the second generate did not drop the first.
    const barrel = await Deno.readTextFile(`${project}/src/modules/index.ts`);
    expect(barrel).toContain('UserController');
    expect(barrel).toContain('OrderItemController');

    // And the config consumes it, so both are registered with no hand edit.
    const config = await Deno.readTextFile(`${project}/setu.config.ts`);
    expect(config).toContain("from './src/modules/index.ts'");
    expect(config).toContain('...MODULE_CONTROLLERS');

    const sources = [
      `${project}/main.ts`,
      `${project}/setu.config.ts`,
      ...(await moduleSources(project)),
    ];
    await useWorkspacePackages(project);
    const { code, stderr } = await denoCheck(project, sources);
    expect(stderr).not.toContain('SyntaxError');
    expect(code).toBe(0);
  });

  // `rest` has no DiPlugin, `nest` does, and DecoratorPlugin branches on the
  // container's presence — so the emitted `@Inject` has to compile and resolve
  // on both paths, not just the one the showcase template takes.
  it('type-checks a nest project carrying a generated module', async () => {
    expect(await run(['new', 'shop', '--template', 'nest'])).toBe(0);
    const project = `${root}/shop`;

    expect(await run(['g', 'module', 'user', '--dir', project])).toBe(0);

    const config = await Deno.readTextFile(`${project}/setu.config.ts`);
    // The seam must not have displaced the template's own example classes.
    expect(config).toContain('GreetingController');
    expect(config).toContain('...MODULE_CONTROLLERS');

    const sources = [
      `${project}/main.ts`,
      `${project}/setu.config.ts`,
      `${project}/src/greeting-controller.ts`,
      `${project}/src/greeting-service.ts`,
      ...(await moduleSources(project)),
    ];
    await useWorkspacePackages(project);
    const { code, stderr } = await denoCheck(project, sources);
    expect(stderr).not.toContain('SyntaxError');
    expect(code).toBe(0);
  });

  it('regenerates the barrel without refusing, and lists each module once', async () => {
    await run(['new', 'shop', '--template', 'rest']);
    const project = `${root}/shop`;
    await run(['g', 'module', 'user', '--dir', project]);

    // A second module rewrites the barrel — the managed-file exemption is what
    // makes this exit 0 rather than refusing on an existing path.
    expect(await run(['g', 'module', 'billing', '--dir', project])).toBe(0);

    const barrel = await Deno.readTextFile(`${project}/src/modules/index.ts`);
    expect(barrel.match(/UserController/g)?.length).toBe(2); // import + array entry
    expect(barrel.match(/from '\.\/user\/user\.controller\.ts'/g)?.length).toBe(1);
  });

  /**
   * Boots a scaffolded project in a subprocess and returns the probe's JSON.
   *
   * A subprocess rather than an in-process import: the project resolves
   * `@setu-ts/*` through its own manifest, and running it here would load a
   * second copy of the framework into this test process.
   *
   * @param project - The project directory, already repointed at the workspace
   * @param probe - The probe module source, written into the project
   * @returns The parsed JSON the probe printed
   */
  async function bootAndProbe(
    project: string,
    probe: string,
  ): Promise<Record<string, { status: number; body: string }>> {
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
    // The booted app logs its own JSON lines to stdout, so the result is carried
    // on ONE line behind a marker rather than located by shape — searching for a
    // brace finds the app's log records, or a nested object inside the result.
    const line = out.split('\n').find((l) => l.startsWith(PROBE_MARKER));
    if (line === undefined) throw new Error(`probe printed no result:\n${out}`);
    return JSON.parse(line.slice(PROBE_MARKER.length));
  }

  /** Prefix the probe puts its one-line JSON result behind. */
  const PROBE_MARKER = '__PROBE_RESULT__';

  /** A probe that drives a generated standalone controller. */
  const CONTROLLER_PROBE = `import { createApp } from './setu.config.ts';
const app = await createApp();
await app.start();
const r = await app.inject({ method: 'GET', url: '/widgets' });
console.log('__PROBE_RESULT__' + JSON.stringify({
  'GET /widgets': { status: r.statusCode, body: r.body },
}));
await app.stop();
`;

  /** A probe that drives both generated modules through the real pipeline. */
  const MODULE_PROBE = `import { createApp } from './setu.config.ts';
const app = await createApp();
await app.start();
const out: Record<string, unknown> = {};
for (const url of ['/orders', '/order-item']) {
  const r = await app.inject({ method: 'GET', url });
  out[\`GET \${url}\`] = { status: r.statusCode, body: r.body };
}
const p = await app.inject({
  method: 'POST',
  url: '/orders',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ sku: 'ABC-1' }),
});
out['POST /orders'] = { status: p.statusCode, body: p.body };
console.log('__PROBE_RESULT__' + JSON.stringify(out));
await app.stop();
`;

  // The proof that matters, and the one every other check in this milestone
  // missed: `deno check` and the unit assertions both passed while every route a
  // generated module declared answered 500, because the plugin builds a handler's
  // arguments from parameter metadata alone and the emitted handler expected the
  // context positionally. Compiling is not working.
  for (const template of ['rest', 'nest']) {
    it(`serves requests from generated modules on --template ${template}`, async () => {
      expect(await run(['new', 'shop', '--template', template])).toBe(0);
      const project = `${root}/shop`;
      expect(await run(['g', 'module', 'orders', '--dir', project])).toBe(0);
      expect(await run(['g', 'module', 'order-item', '--dir', project])).toBe(0);
      await useWorkspacePackages(project);

      const out = await bootAndProbe(project, MODULE_PROBE);

      // The injected service's return value reached the response body, so
      // `@Inject` resolved — on `rest` that is the ServiceRegistry path, with no
      // DI container present at all.
      expect(out['GET /orders']).toEqual({ status: 200, body: '{"items":[]}' });
      // The second module registered too, so the barrel wired both.
      expect(out['GET /order-item']).toEqual({ status: 200, body: '{"items":[]}' });
      // `@Body()` parsed and round-tripped.
      expect(out['POST /orders'].status).toBe(200);
      expect(out['POST /orders'].body).toContain('ABC-1');
    });
  }

  // `g controller` carried the identical broken shape, so every project that ever
  // ran it got a 500 from the controller it generated. Same package and the same
  // one-line class of fix, so it ships here rather than on a separate branch
  // (a deliberate deviation from this milestone's plan, at the maintainer's call).
  it('serves requests from a generated standalone controller', async () => {
    expect(await run(['new', 'shop', '--template', 'rest'])).toBe(0);
    const project = `${root}/shop`;
    expect(await run(['g', 'controller', 'widgets', '--dir', project])).toBe(0);

    // A standalone controller is not in the module barrel, so the config has to
    // name it — which is what a developer does by hand after generating one.
    const config = await Deno.readTextFile(`${project}/setu.config.ts`);
    await Deno.writeTextFile(
      `${project}/setu.config.ts`,
      config
        .replace(
          'import { MODULE_CONTROLLERS',
          "import { WidgetsController } from './src/controllers/widgets.controller.ts';\nimport { MODULE_CONTROLLERS",
        )
        .replace('controllers: [...MODULE_CONTROLLERS]', 'controllers: [WidgetsController]'),
    );
    await useWorkspacePackages(project);

    const out = await bootAndProbe(project, CONTROLLER_PROBE);

    expect(out['GET /widgets']).toEqual({ status: 200, body: '{"items":[]}' });
  });

  it('still refuses to overwrite a module that already exists', async () => {
    await run(['new', 'shop', '--template', 'rest']);
    const project = `${root}/shop`;
    await run(['g', 'module', 'user', '--dir', project]);
    err = [];

    expect(await run(['g', 'module', 'user', '--dir', project])).toBe(1);

    expect(err.join('\n')).toContain('user.service.ts');
  });
});
