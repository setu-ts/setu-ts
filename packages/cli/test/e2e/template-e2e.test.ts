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
import { collectSources, denoCheck, useWorkspacePackages } from '../fixtures/generated-project.ts';

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
 * Every single-file schematic the class-based template's plugin set makes available.
 *
 * Retained as the authoritative list of what a REST project can generate, and used by
 * {@linkcode NON_COLLIDING_GROUPS} to check that the groups below partition it — a
 * schematic added to one and not the other would drop out of the sweep unnoticed.
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
const MODULE_FILES_PER_NAME = 5;

/**
 * Families that can share one name, grouped so no group contains a collision.
 *
 * `route`, `controller` and `module` all mount `/<name>`, and `service` and `module` both
 * register `<name>-service` — generating two of either set under one name is refused,
 * because the kernel's router silently overwrites a duplicate and the decorator plugin
 * keeps only the first class under a token. So the sweep runs one project per group.
 */
const NON_COLLIDING_GROUPS: Readonly<Record<string, readonly string[]>> = {
  ungated: [...UNGATED],
  controller: ['controller'],
  module: ['module'],
};

/**
 * Seam barrels a class-based project carries from scaffold time, before anything is generated.
 *
 * Counted separately from the generated files because they exist whether or not the group
 * under test writes into their directories: `src/modules/index.ts` plus one each for
 * controllers, services, middleware, plugins, health and metrics.
 *
 * SEVEN since M70h/E8, not eight: `route` and `controller` share
 * `src/controllers/index.ts`, so the separate `src/routes/index.ts` is gone.
 */
const SCAFFOLDED_BARRELS = 7;

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

  it('emits a resolvable controller in a project without the decorator plugin', async () => {
    // The gate existed because the schematic emitted @Controller/@Get/@Post
    // unconditionally, so an ungated generate produced source whose own import
    // could not resolve. E8 replaced the gate with a SHAPE: the functional form
    // imports `@setu-ts/common` alone, so the file compiles in a bare project
    // and the refusal is no longer needed.
    await run(['new', 'bare']);
    expect(await run(['g', 'controller', 'user', '--dir', `${root}/bare`])).toBe(0);

    const module = await Deno.readTextFile(`${root}/bare/src/controllers/user.controller.ts`);
    // The IMPORT is the property under test, not the word: the JSDoc names the
    // plugin deliberately, to tell the reader how to get the decorated form.
    expect(module).not.toContain("from '@setu-ts/decorator-plugin'");
    expect(module).toContain('registerUserRoutes');
  });

  it('allows a controller in a class-based project', async () => {
    await run(['new', 'svc', '--template', 'class-based']);
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

  // The `class-based` template is the only one whose config imports project-local
  // modules, and one of two carrying an `args` string (see the `microservice`
  // case below). Both are rendered source that nothing else validates: an
  // `args` string naming an undeclared identifier, or a `localImports` path
  // that does not resolve, type-checks nowhere else in the suite. This is that
  // check.
  it('type-checks the scaffolded class-based project, including its emitted classes', async () => {
    expect(await run(['new', 'svc', '--template', 'class-based'])).toBe(0);
    const project = `${root}/svc`;

    const sources = [
      `${project}/main.ts`,
      `${project}/setu.config.ts`,
      `${project}/src/services/greeting.service.ts`,
      `${project}/src/controllers/greeting.controller.ts`,
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

  it('refuses the retired independent DI switch', async () => {
    expect(await run(['new', 'svc', '--template', 'rest', '--di'])).toBe(2);
    expect(err.join('\n')).toContain('--template class-based');
  });

  // The microservice template was refused outright on Workers until its runtime
  // swap existed, so NOTHING here had ever been scaffolded, let alone checked.
  // Everything the swap contributes is a rendered string as far as the CLI's own
  // `deno check` is concerned — the `workersArgs` option object, the DO class
  // module, the `queue` export's signature — so this is the only place a wrong
  // field name or a bad import is a compile error (the M50b trap).
  it('type-checks the scaffolded microservice project on Cloudflare Workers', async () => {
    expect(
      await run(['new', 'edge', '--template', 'microservice', '--runtime', 'cloudflare-workers']),
    ).toBe(0);
    const project = `${root}/edge`;

    const config = await Deno.readTextFile(`${project}/setu.config.ts`);
    // The swap happened: the two socket-bound plugins are gone and the platform
    // plugin serves both capabilities in their place.
    expect(config).not.toContain('MessagingPlugin');
    expect(config).not.toContain('QueuePlugin');
    expect(config).toContain("import { CloudflarePlugin } from '@setu-ts/cloudflare-plugin';");
    expect(config).toContain("messaging: { binding: 'MESSAGES'");
    expect(config).toContain("queue: { binding: 'JOBS' }");

    // The consumer half is a module export, which no plugin option can declare.
    const entry = await Deno.readTextFile(`${project}/src/index.ts`);
    expect(entry).toContain('async queue(');
    expect(entry).toContain("export { ReplyInboxObject } from './reply-inbox-object.ts';");
    // Cloudflare invokes ONE queue export for every consumed queue, so messaging
    // and jobs must be told apart by name — otherwise the messaging broker gets
    // job batches it cannot read and retries them to the dead-letter queue.
    expect(entry).toContain('switch (payload.queue)');
    expect(entry).toContain('createMessagingHandler(app)(payload)');
    expect(entry).toContain('createQueueHandler(app)(payload)');

    // `max_batch_timeout = 0` is what makes request/reply usable at all; the
    // platform default of 5s alone exhausts the default reply budget.
    const wrangler = await Deno.readTextFile(`${project}/wrangler.toml`);
    expect(wrangler).toContain('max_batch_timeout = 0');
    expect(wrangler).toContain('[[queues.producers]]');
    expect(wrangler).toContain('class_name = "ReplyInboxObject"');
    expect(wrangler).toContain('new_classes = ["ReplyInboxObject"]');

    // The DO class is checked too, which is only possible because it does NOT
    // import `cloudflare:workers` — a specifier Deno cannot resolve.
    const sources = [
      `${project}/src/index.ts`,
      `${project}/setu.config.ts`,
      `${project}/src/reply-inbox-object.ts`,
    ];
    await useWorkspacePackages(project);
    const { code, stderr } = await denoCheck(project, sources);
    expect(stderr).not.toContain('SyntaxError');
    expect(code).toBe(0);
  });

  // Every other runtime keeps the socket-bound brokers, so the swap must be
  // scoped to Workers rather than applied to the template.
  it('leaves the microservice plugin set unchanged on the other runtimes', async () => {
    expect(await run(['new', 'a', '--template', 'microservice', '--runtime', 'deno'])).toBe(0);
    expect(await run(['new', 'b', '--template', 'microservice', '--runtime', 'node'])).toBe(0);

    for (const name of ['a', 'b']) {
      const config = await Deno.readTextFile(`${root}/${name}/setu.config.ts`);
      expect(config).toContain('MessagingPlugin()');
      expect(config).toContain('QueuePlugin()');
      expect(config).not.toContain('CloudflarePlugin');
    }

    // And no Workers-only artifact leaks onto them.
    await expect(Deno.stat(`${root}/a/src/reply-inbox-object.ts`)).rejects.toThrow();
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

  it('wires the class-based config with DI and the emitted classes', async () => {
    expect(await run(['new', 'svc', '--template', 'class-based'])).toBe(0);
    const config = await Deno.readTextFile(`${root}/svc/setu.config.ts`);

    // The args string, rendered into the plugin call. The showcase classes come
    // first, then the standalone barrels, then the module barrel — so `setu g controller`
    // and `setu g module` both add to this registration rather than replacing it.
    // Broken across lines because the single-line form runs past 110 characters inside
    // the plugin array once all three sources are named.
    expect(config).toContain(
      'DecoratorPlugin({\n' +
        '        controllers: [...APP_CONTROLLERS],\n' +
        '        services: [...APP_SERVICES],\n' +
        '        modules: [...MODULES],\n' +
        '      }),',
    );
    // DiPlugin is what puts @Injectable classes on the container path. Since
    // M70d (E3) it emits `autoRegister: true`, because the default disables the
    // container's only route to the framework's own services.
    expect(config).toContain('DiPlugin({ autoRegister: true })');
    // The local imports that bring the args identifiers into scope.
    // E4: the showcase reaches the config through the seam barrels now, not by
    // explicit path — which is the signal a developer copies when adding theirs.
    expect(config).toContain("from './src/controllers/index.ts'");
    expect(config).toContain("from './src/services/index.ts'");
    expect(config).toContain("from './src/modules/index.ts'");
  });

  // X5-2. TypeScript does NOT apply excess-property checking to an object
  // literal returned from a contextually-typed callback, so the generated
  // `(config) => ({ … })` accepted arms and options that do not exist: both
  // type-checked, booted, and logged nothing. Probed against the real type
  // before choosing the fix — with a RETURN TYPE annotation the same literal
  // raises TS2561 naming the key and its nearest match; without it, nothing.
  describe('the full-stack config resolver', () => {
    it('emits the annotation that restores excess-property checking', async () => {
      expect(await run(['new', 'shop', '--template', 'full-stack'])).toBe(0);
      const config = await Deno.readTextFile(`${root}/shop/setu.config.ts`);

      expect(config).toContain('(config): FullStackStarterOptions => ({');
      expect(config).toContain("type FullStackStarterOptions } from '@setu-ts/full-stack-starter'");
    });

    it('makes a misspelled arm a COMPILE error in the generated project', async () => {
      expect(await run(['new', 'shop', '--template', 'full-stack'])).toBe(0);
      const project = `${root}/shop`;
      await useWorkspacePackages(project);

      // The typo goes into the real generated file, in the real position, so
      // this measures the shipped resolver rather than a hand-built stand-in.
      const path = `${project}/setu.config.ts`;
      const original = await Deno.readTextFile(path);
      await Deno.writeTextFile(
        path,
        original.replace('    session: {', '    sessionn: { secret: 0 },\n    session: {'),
      );

      const { code, stderr } = await denoCheck(project, [path]);
      expect(code).not.toBe(0);
      expect(stderr).toContain('sessionn');

      // Restored, so the mutation cannot leak into another assertion.
      await Deno.writeTextFile(path, original);
      const clean = await denoCheck(project, [path]);
      expect(clean.code, clean.stderr).toBe(0);
    });
  });

  // X5-8. The generated README tells the developer to run `setu generate
  // service` / `route`, and doing so wrote into `src/` — a second service
  // directory beside the template's own `app/services/`, wired by nothing and
  // checked by NEITHER of the project's own check paths. The route answered 404.
  describe('the full-stack seam host', () => {
    it('type-checks a generated artifact through the project OWN check task', async () => {
      expect(await run(['new', 'shop', '--template', 'full-stack'])).toBe(0);
      const project = `${root}/shop`;
      expect(await run(['g', 'route', 'widget', '--dir', project])).toBe(0);
      await useWorkspacePackages(project);

      // A deliberate type error in the generated artifact. Before X5-8 this was
      // clean under `check:app` (which globbed `app/` only) AND under
      // `deno check main.ts setu.config.ts` (which never reached `src/`).
      const path = `${project}/src/controllers/widget.routes.ts`;
      const original = await Deno.readTextFile(path);
      await Deno.writeTextFile(
        path,
        original.replace(
          'export function registerWidgetRoutes',
          'const broken: number = "x";\nexport function registerWidgetRoutes',
        ),
      );

      const checkTask = new Deno.Command(Deno.execPath(), {
        args: ['task', 'check:app'],
        cwd: project,
        stdout: 'piped',
        stderr: 'piped',
      });
      const broken = await checkTask.output();
      expect(broken.code).not.toBe(0);

      await Deno.writeTextFile(path, original);
      const clean = await new Deno.Command(Deno.execPath(), {
        args: ['task', 'check:app'],
        cwd: project,
        stdout: 'piped',
        stderr: 'piped',
      }).output();
      expect(clean.code, new TextDecoder().decode(clean.stderr)).toBe(0);
    });

    it('imports the seam barrels from the generated config', async () => {
      expect(await run(['new', 'shop', '--template', 'full-stack'])).toBe(0);
      const config = await Deno.readTextFile(`${root}/shop/setu.config.ts`);

      expect(config).toContain("from './src/controllers/index.ts'");
      expect(config).toContain('registerGeneratedRoutes(app.router, app.services);');
      // No plugin ARRAY exists on this path, so the plugin seam registers
      // imperatively instead of spreading.
      expect(config).toContain('app.register(generated)');
    });
  });

  it('emits parameter-level @Inject in the class-based controller', async () => {
    expect(await run(['new', 'svc', '--template', 'class-based'])).toBe(0);
    const controller = await Deno.readTextFile(
      `${root}/svc/src/controllers/greeting.controller.ts`,
    );
    // The showcase is the parameter position, not the deprecated class-level list.
    expect(controller).toContain("@Inject('greeting-service')");
    expect(controller).not.toContain("@Inject('greeting-service')\n@Controller");
  });

  it('accepts the class-based template on every runtime target', async () => {
    // Nothing in the template needs raw sockets.
    for (const target of ['deno', 'node', 'bun', 'cloudflare-workers']) {
      out = [];
      err = [];
      expect(await run(['new', `svc-${target}`, '--template', 'class-based', '--runtime', target]))
        .toBe(
          0,
        );
    }
  });

  // Swept in three projects rather than one, because `route`, `controller` and `module`
  // all mount `/<name>` and `service` and `module` both claim `<name>-service` — so a
  // single project generating every family under one name now hits the collision guard
  // rather than the drift check. Splitting keeps the hostile name EXACT for every
  // schematic, which is the whole point of the sweep; folding a suffix into the name
  // instead would mean `class` never lands in a binding position again.
  it('partitions every REST-available schematic across the sweep groups', () => {
    // Without this, adding a schematic to `REST_AVAILABLE` and forgetting a group would
    // silently drop it from the hostile-name sweep entirely.
    const swept = Object.values(NON_COLLIDING_GROUPS).flat().sort();
    expect(swept).toEqual([...REST_AVAILABLE, 'module'].sort());
  });

  for (const [group, schematics] of Object.entries(NON_COLLIDING_GROUPS)) {
    it(`type-checks a ${group} project generated over every accepted name`, async () => {
      expect(await run(['new', 'svc', '--template', 'class-based'])).toBe(0);
      const project = `${root}/svc`;

      for (const { name, accepted } of HOSTILE_NAMES) {
        if (!accepted) continue;
        for (const schematic of schematics) {
          expect(await run(['g', schematic, name, '--dir', project])).toBe(0);
        }
      }

      const sources: string[] = [
        `${project}/main.ts`,
        `${project}/setu.config.ts`,
        ...(await collectSources(`${project}/src`)),
      ];
      const accepted = HOSTILE_NAMES.filter((n) => n.accepted).length;
      // Per accepted name: one artifact file per single-file schematic, or
      // MODULE_FILES_PER_NAME for the aggregate. Plus one seam barrel per family that has
      // one — emitted at SCAFFOLD time, so every host carries all eight whether or not
      // this group generated into them — plus the two entry points.
      const perName = group === 'module' ? MODULE_FILES_PER_NAME : schematics.length;
      // The class-based template adds its greeting service and controller.
      expect(sources.length).toBe(perName * accepted + SCAFFOLDED_BARRELS + 4);

      await useWorkspacePackages(project);
      const { code, stderr } = await denoCheck(project, sources);
      expect(stderr).not.toContain('SyntaxError');
      expect(code).toBe(0);
    });
  }
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
    expect(await run(['new', 'shop', '--template', 'class-based'])).toBe(0);
    const project = `${root}/shop`;

    expect(await run(['g', 'module', 'user', '--dir', project])).toBe(0);
    expect(await run(['g', 'module', 'order-item', '--dir', project])).toBe(0);

    // The barrel names both modules — the second generate did not drop the first.
    const barrel = await Deno.readTextFile(`${project}/src/modules/index.ts`);
    expect(barrel).toContain('UserModule');
    expect(barrel).toContain('OrderItemModule');

    // And the config consumes it, so both are registered with no hand edit.
    const config = await Deno.readTextFile(`${project}/setu.config.ts`);
    expect(config).toContain("from './src/modules/index.ts'");
    expect(config).toContain('...MODULES');

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

  // The class-based template includes the DI pair, so its emitted `@Inject` has
  // container's presence — so the emitted `@Inject` has to compile and resolve
  // on both paths, not just the one the showcase template takes.
  it('type-checks a class-based project carrying a generated module', async () => {
    expect(await run(['new', 'shop', '--template', 'class-based'])).toBe(0);
    const project = `${root}/shop`;

    expect(await run(['g', 'module', 'user', '--dir', project])).toBe(0);

    const config = await Deno.readTextFile(`${project}/setu.config.ts`);
    // The seam must not have displaced the template's own example classes.
    // E4: the showcase reaches the config through APP_CONTROLLERS rather than
    // by name, so the assertion is that BOTH registration paths are present —
    // the standalone barrel (which carries the showcase) and the module barrel.
    expect(config).toContain('...APP_CONTROLLERS');
    expect(config).toContain('...MODULES');

    const sources = [
      `${project}/main.ts`,
      `${project}/setu.config.ts`,
      `${project}/src/controllers/greeting.controller.ts`,
      `${project}/src/services/greeting.service.ts`,
      ...(await moduleSources(project)),
    ];
    await useWorkspacePackages(project);
    const { code, stderr } = await denoCheck(project, sources);
    expect(stderr).not.toContain('SyntaxError');
    expect(code).toBe(0);
  });

  it('regenerates the barrel without refusing, and lists each module once', async () => {
    await run(['new', 'shop', '--template', 'class-based']);
    const project = `${root}/shop`;
    await run(['g', 'module', 'user', '--dir', project]);

    // A second module rewrites the barrel — the managed-file exemption is what
    // makes this exit 0 rather than refusing on an existing path.
    expect(await run(['g', 'module', 'billing', '--dir', project])).toBe(0);

    const barrel = await Deno.readTextFile(`${project}/src/modules/index.ts`);
    expect(barrel.match(/UserModule/g)?.length).toBe(2); // import + array entry
    expect(barrel.match(/from '\.\/user\/user\.module\.ts'/g)?.length).toBe(1);
  });

  // The module schematic is UNGATED since M65, so it emits a runnable test into
  // every host — including the two that declared none of what that test
  // imports. Both scaffolded cleanly, generated cleanly, reported `created
  // …/widget.service.test.ts`, and then failed the developer's first `deno
  // test` with `Import "@std/testing/bdd" not a dependency and not in import
  // map`: the M58 defect, reintroduced by ungating.
  //
  // Checked with a real `deno check` of the emitted TEST file, not a manifest
  // assertion — a manifest assertion is what the unit gate does, and it cannot
  // see whether Deno actually resolves the specifier from the project.
  for (
    const [label, argv] of [
      ['no template', ['new', 'bare']],
      ['--template rest', ['new', 'bare', '--template', 'rest']],
      ['--template full-stack', ['new', 'bare', '--template', 'full-stack']],
    ] as const
  ) {
    it(`type-checks the module test it generates into a ${label} project`, async () => {
      expect(await run(argv)).toBe(0);
      const project = `${root}/bare`;
      expect(await run(['g', 'module', 'widget', '--dir', project])).toBe(0);

      await useWorkspacePackages(project);
      const { code, stderr } = await denoCheck(project, [
        `${project}/src/modules/widget/widget.service.test.ts`,
      ]);
      expect(stderr).not.toContain('not in import map');
      expect(code).toBe(0);
    });
  }

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
      cwd: project,
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
  for (const template of ['rest', 'class-based']) {
    it(`serves requests from generated modules on --template ${template}`, async () => {
      expect(await run(['new', 'shop', '--template', template])).toBe(0);
      const project = `${root}/shop`;
      expect(await run(['g', 'module', 'orders', '--dir', project])).toBe(0);
      expect(await run(['g', 'module', 'order-item', '--dir', project])).toBe(0);
      await useWorkspacePackages(project);

      const out = await bootAndProbe(project, MODULE_PROBE);

      expect(out['GET /orders']).toEqual({ status: 200, body: '{"items":[]}' });
      // The second module registered too, so the barrel wired both.
      expect(out['GET /order-item']).toEqual({ status: 200, body: '{"items":[]}' });
      expect(out['POST /orders'].status).toBe(201);
    });
  }

  // `g controller` carried the identical broken shape, so every project that ever
  // ran it got a 500 from the controller it generated. Same package and the same
  // one-line class of fix, so it ships here rather than on a separate branch
  // (a deliberate deviation from this milestone's plan, at the maintainer's call).
  it('serves requests from a generated standalone controller', async () => {
    expect(await run(['new', 'shop', '--template', 'class-based'])).toBe(0);
    const project = `${root}/shop`;
    expect(await run(['g', 'controller', 'widgets', '--dir', project])).toBe(0);

    // The class-based template's controller barrel is already registered by
    // `DecoratorPlugin`, so no developer-owned config edit is necessary.
    await useWorkspacePackages(project);

    const out = await bootAndProbe(project, CONTROLLER_PROBE);

    expect(out['GET /widgets']).toEqual({ status: 200, body: '{"items":[]}' });
  });

  it('still refuses to overwrite a module that already exists', async () => {
    await run(['new', 'shop', '--template', 'class-based']);
    const project = `${root}/shop`;
    await run(['g', 'module', 'user', '--dir', project]);
    err = [];

    expect(await run(['g', 'module', 'user', '--dir', project])).toBe(1);

    expect(err.join('\n')).toContain('user.service.ts');
  });
});
