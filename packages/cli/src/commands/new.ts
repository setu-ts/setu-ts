/**
 * The `honoe new` command — project scaffolding.
 *
 * @module
 */

import type { IFileSystem } from '@hono-enterprise/common';
import type { ParsedArgs } from '../args.ts';
import { stringFlag } from '../args.ts';
import {
  CONFIG_EXPORT,
  CONFIG_MODULE,
  EXIT_ERROR,
  EXIT_OK,
  EXIT_USAGE,
  isTargetRuntime,
  isTemplateName,
  PROGRAM_NAME,
  TARGET_RUNTIMES,
  type TargetRuntime,
  TEMPLATES,
  VERSION,
} from '../constants.ts';
import {
  getTemplate,
  listTemplates,
  type MiddlewareWiring,
  MINIMAL_PLUGINS,
  packagesOf,
  type Wiring,
} from '../templates/registry.ts';
import { deriveNames } from '../utils/names.ts';
import {
  findExisting,
  type GeneratedFile,
  joinPath,
  resolveDir,
  writeFiles,
} from '../utils/file-writer.ts';

/**
 * Everything `runNewCommand` reaches the outside world through.
 */
export interface NewDependencies {
  /** The filesystem to write the project through. */
  readonly fs: IFileSystem;
  /** The directory new projects are created under (absolute). */
  readonly cwd: string;
  /** Writes a line of normal output. */
  readonly log: (message: string) => void;
  /** Writes a line of error output. */
  readonly error: (message: string) => void;
}

/** Semver range the scaffolded project pins framework packages to. */
const RANGE = `^${VERSION}`;

/**
 * Renders a middleware wiring's `add()` options as source, including the
 * leading comma.
 *
 * Always emits both fields: a middleware's pipeline position is never
 * incidental, and `MiddlewareWiring.addOptions` is required precisely so this
 * cannot degrade to a bare `add()` at the default priority of 500.
 *
 * @param options - The wiring's declared position and name
 * @returns Source for the second argument to `app.middleware.add(...)`
 */
function renderAddOptions(options: MiddlewareWiring['addOptions']): string {
  return `, { priority: ${options.priority}, name: '${options.name}' }`;
}

/**
 * Renders the project's `honoe.config.ts` — the single place its plugin list
 * lives.
 *
 * The factory deliberately does NOT start the application: `main.ts` owns that,
 * and `honoe` imports this module to discover plugin-contributed commands, so
 * importing it must never bind a socket.
 *
 * @param plugins - Plugins to pass to `createApplication`
 * @param middleware - Middleware to add after construction
 * @returns The `honoe.config.ts` contents
 */
function configModule(
  plugins: readonly Wiring[],
  middleware: readonly MiddlewareWiring[],
): string {
  const imports = [
    `import { createApplication } from '@hono-enterprise/kernel';`,
    `import type { IApplication } from '@hono-enterprise/common';`,
    ...plugins.map((p) => `import { ${p.symbol} } from '@hono-enterprise/${p.pkg}';`),
    ...middleware.map((m) => `import { ${m.symbol} } from '@hono-enterprise/${m.pkg}';`),
  ].join('\n');

  const pluginList = plugins.map((p) => `      ${p.symbol}(),`).join('\n');
  const middlewareLines = middleware.length === 0 ? '' : `\n${
    middleware
      .map((m) => `  app.middleware.add(${m.symbol}()${renderAddOptions(m.addOptions)});`)
      .join('\n')
  }\n`;

  return `${imports}

/**
 * Builds the application.
 *
 * \`honoe\` imports this factory to discover plugin-contributed CLI commands, so
 * it must NOT start the server — \`main.ts\` owns that.
 *
 * @returns The configured, unstarted application
 */
export function ${CONFIG_EXPORT}(): IApplication {
  const app = createApplication({
    plugins: [
${pluginList}
    ],
  });
${middlewareLines}
  app.router.get('/', (ctx) => ctx.response.json({ message: 'Hello, World!' }));

  return app;
}
`;
}

/**
 * The application entry shared by the Deno, Node, and Bun targets.
 *
 * All three bind a socket through `app.start({ port })`, which delegates to the
 * runtime's Hono serve adapter (M23). The plugin list lives in
 * {@linkcode configModule}, not here.
 *
 * @returns The `main.ts` contents
 */
function serveEntry(): string {
  return `import { ${CONFIG_EXPORT} } from './${CONFIG_MODULE}';

const app = await ${CONFIG_EXPORT}();

await app.start({ port: 3000 });
`;
}

/**
 * The Cloudflare Workers entry: a `fetch` export, never a `listen`.
 *
 * Startup is deferred to the first request and memoized, rather than kicked off
 * at module scope. A module-scope `start()` whose promise is only awaited later
 * leaves a window in which a rejection has no handler attached.
 *
 * @returns The `src/index.ts` contents
 */
function workersEntry(): string {
  return `import type { IApplication } from '@hono-enterprise/common';
import { ${CONFIG_EXPORT} } from '../${CONFIG_MODULE}';

let booted: Promise<IApplication> | undefined;

/**
 * Builds and starts the application once, on the first request.
 *
 * Workers have no socket to bind, so start() takes no port: it registers the
 * plugins and the platform drives the app through fetch().
 */
async function boot(): Promise<IApplication> {
  const app = await ${CONFIG_EXPORT}();
  await app.start();
  return app;
}

export default {
  async fetch(request: Request): Promise<Response> {
    booted ??= boot();
    const app = await booted;
    return await app.fetch(request);
  },
};
`;
}

/**
 * Every framework package a generated project depends on.
 *
 * Always includes `kernel` and `common` (the config module imports both) plus
 * one entry per wiring, so the manifest can never omit a package the generated
 * source references.
 *
 * @param wirings - The template's plugin and middleware wirings
 * @returns Bare package names, deduplicated
 */
function frameworkPackages(...wirings: readonly (readonly Wiring[])[]): readonly string[] {
  // `kernel` and `common` are unconditional: the config module imports
  // createApplication and IApplication regardless of the template.
  const packages = new Set<string>(['kernel', 'common']);
  for (const pkg of packagesOf(...wirings)) packages.add(pkg);
  return [...packages];
}

/**
 * Builds the Deno `imports` map for a generated project.
 *
 * @param wirings - The template's plugin and middleware wirings
 * @returns Specifier → `jsr:` URL
 */
function jsrImports(...wirings: readonly (readonly Wiring[])[]): Record<string, string> {
  const imports: Record<string, string> = {};
  for (const pkg of frameworkPackages(...wirings)) {
    imports[`@hono-enterprise/${pkg}`] = `jsr:@hono-enterprise/${pkg}@${RANGE}`;
  }
  return imports;
}

/**
 * Builds the npm `dependencies` map for a generated project, using JSR's npm
 * compatibility names.
 *
 * @param wirings - The template's plugin and middleware wirings
 * @returns Specifier → `npm:@jsr/…` range
 */
function npmDependencies(...wirings: readonly (readonly Wiring[])[]): Record<string, string> {
  const deps: Record<string, string> = {};
  for (const pkg of frameworkPackages(...wirings)) {
    deps[`@hono-enterprise/${pkg}`] = `npm:@jsr/hono-enterprise__${pkg}@${RANGE}`;
  }
  return deps;
}

/**
 * Builds the file set for one runtime target and plugin set.
 *
 * @param projectName - The project directory and manifest name
 * @param runtime - The selected runtime target
 * @param plugins - Plugins the generated `honoe.config.ts` registers
 * @param middleware - Middleware the generated `honoe.config.ts` adds
 * @returns The files to create, relative to the project root
 */
function projectFiles(
  projectName: string,
  runtime: TargetRuntime,
  plugins: readonly Wiring[],
  middleware: readonly MiddlewareWiring[],
): readonly GeneratedFile[] {
  const readme = `# ${projectName}

A [Hono Enterprise](https://github.com/dkpaul91/hono-enterprise) project targeting \`${runtime}\`.

## Run

\`\`\`bash
${
    runtime === 'deno'
      ? 'deno task start'
      : runtime === 'cloudflare-workers'
      ? 'npx wrangler dev'
      : runtime === 'bun'
      ? 'bun run start'
      : 'npm start'
  }
\`\`\`

## Generate code

\`\`\`bash
${PROGRAM_NAME} generate service billing
${PROGRAM_NAME} generate --help
\`\`\`
`;

  const gitignore = runtime === 'deno' ? 'coverage/\n' : 'node_modules/\ncoverage/\n.wrangler/\n';

  const files: GeneratedFile[] = [
    { path: 'README.md', contents: readme },
    { path: '.gitignore', contents: gitignore },
  ];

  if (runtime === 'deno' || runtime === 'cloudflare-workers') {
    const entry = runtime === 'deno' ? 'main.ts' : 'src/index.ts';
    files.push({
      path: 'deno.json',
      contents: `${
        JSON.stringify(
          {
            tasks: { start: `deno run --allow-net --allow-env ${entry}` },
            // The decorator and OpenAPI plugins ship legacy decorators, so a
            // generated @Controller class only type-checks with this enabled.
            compilerOptions: { experimentalDecorators: true },
            imports: jsrImports(plugins, middleware),
          },
          null,
          2,
        )
      }\n`,
    });
  } else {
    files.push({
      path: 'package.json',
      contents: `${
        JSON.stringify(
          {
            name: projectName,
            version: '0.1.0',
            type: 'module',
            scripts: {
              start: runtime === 'bun'
                ? 'bun run main.ts'
                : 'node --experimental-strip-types main.ts',
            },
            dependencies: npmDependencies(plugins, middleware),
          },
          null,
          2,
        )
      }\n`,
    });
    // JSR packages resolve from npm only when the @jsr scope is mapped.
    files.push({ path: '.npmrc', contents: '@jsr:registry=https://npm.jsr.io\n' });
    files.push({
      path: 'tsconfig.json',
      contents: `${
        JSON.stringify(
          {
            compilerOptions: {
              target: 'ES2022',
              module: 'ESNext',
              moduleResolution: 'bundler',
              strict: true,
              // Required by the decorator and OpenAPI plugins.
              experimentalDecorators: true,
              verbatimModuleSyntax: true,
              skipLibCheck: true,
            },
          },
          null,
          2,
        )
      }\n`,
    });
  }

  files.push({ path: CONFIG_MODULE, contents: configModule(plugins, middleware) });

  if (runtime === 'cloudflare-workers') {
    files.push({ path: 'src/index.ts', contents: workersEntry() });
    files.push({
      path: 'wrangler.toml',
      contents: `name = "${projectName}"
main = "src/index.ts"
compatibility_date = "2024-09-23"
compatibility_flags = ["nodejs_compat"]
`,
    });
  } else {
    files.push({ path: 'main.ts', contents: serveEntry() });
  }

  return files;
}

/**
 * Runs `honoe new`.
 *
 * Creates the project under `<dir>/<project-name>`, checking every planned path
 * for an existing file BEFORE the first write, and writing nothing at all under
 * `--dry-run`.
 *
 * @param args - Arguments after the `new` verb, already parsed
 * @param deps - Filesystem and output sinks
 * @returns `0` on success, `1` on a runtime error, `2` on a usage error
 */
export async function runNewCommand(
  args: ParsedArgs,
  deps: NewDependencies,
): Promise<number> {
  const usage =
    `Usage: ${PROGRAM_NAME} new <project-name> [--template <name>] [--runtime <target>] [--dir <path>]`;

  // `--help` is never an error.
  if (args.flags['help'] === true || args.flags['h'] === true) {
    deps.log(usage);
    deps.log('');
    deps.log('Templates:');
    deps.log('  (none)              Minimal — the runtime plugin alone');
    for (const template of listTemplates()) {
      deps.log(`  ${template.name.padEnd(18)}${template.description}`);
    }
    deps.log('');
    deps.log('Options:');
    deps.log(`  --template <name>   ${TEMPLATES.join(' | ')}`);
    deps.log(`  --runtime <target>  ${TARGET_RUNTIMES.join(' | ')} (default deno)`);
    deps.log('  --dir <path>        Create the project under this directory');
    deps.log('  --dry-run           Print what would be created, write nothing');
    return EXIT_OK;
  }

  const rawName = args.positionals[0];
  if (rawName === undefined) {
    deps.error(usage);
    return EXIT_USAGE;
  }

  const runtimeFlag = stringFlag(args.flags, 'runtime');
  if (runtimeFlag !== undefined && !isTargetRuntime(runtimeFlag)) {
    deps.error(
      `Unknown runtime "${runtimeFlag}". Expected one of: ${TARGET_RUNTIMES.join(', ')}.`,
    );
    return EXIT_USAGE;
  }
  const runtime: TargetRuntime = runtimeFlag ?? 'deno';

  const templateFlag = stringFlag(args.flags, 'template');
  if (templateFlag !== undefined && !isTemplateName(templateFlag)) {
    deps.error(
      `Unknown template "${templateFlag}". Expected one of: ${TEMPLATES.join(', ')}.`,
    );
    return EXIT_USAGE;
  }
  const template = templateFlag === undefined ? undefined : getTemplate(templateFlag);

  // Refuse a template/runtime pairing that would deploy and then fail at first
  // use, naming the reason rather than scaffolding a broken project.
  const blocked = template?.unsupported[runtime];
  if (template !== undefined && blocked !== undefined) {
    deps.error(
      `The "${template.name}" template does not support --runtime ${runtime}: ${blocked}.`,
    );
    return EXIT_USAGE;
  }

  const plugins = template?.plugins ?? MINIMAL_PLUGINS;
  const middleware = template?.middleware ?? [];

  const projectName = deriveNames(rawName).kebab;
  if (projectName === '') {
    deps.error(`Invalid project name: "${rawName}".`);
    return EXIT_USAGE;
  }

  const root = joinPath(resolveDir(deps.cwd, stringFlag(args.flags, 'dir')), projectName);
  const files = projectFiles(projectName, runtime, plugins, middleware).map((file) => ({
    path: joinPath(root, file.path),
    contents: file.contents,
  }));

  if (args.flags['dry-run'] === true) {
    for (const file of files) deps.log(`would create ${file.path}`);
    return EXIT_OK;
  }

  const existing = await findExisting(deps.fs, files);
  if (existing.length > 0) {
    deps.error('Refusing to overwrite existing files:');
    for (const path of existing) deps.error(`  ${path}`);
    return EXIT_ERROR;
  }

  try {
    await writeFiles(deps.fs, files);
  } catch (cause) {
    deps.error(`Failed to write: ${cause instanceof Error ? cause.message : String(cause)}`);
    return EXIT_ERROR;
  }

  for (const file of files) deps.log(`created ${file.path}`);
  deps.log('');
  deps.log(`Created ${projectName} (${runtime}). Next:`);
  deps.log(`  cd ${projectName}`);
  deps.log(
    runtime === 'deno'
      ? '  deno task start'
      : runtime === 'cloudflare-workers'
      ? '  npm install && npx wrangler dev'
      : runtime === 'bun'
      ? '  bun install && bun run start'
      : '  npm install && npm start',
  );
  return EXIT_OK;
}
