/**
 * The `honoe new` command — project scaffolding.
 *
 * @module
 */

import type { IFileSystem } from '@hono-enterprise/common';
import type { ParsedArgs } from '../args.ts';
import { stringFlag } from '../args.ts';
import {
  EXIT_ERROR,
  EXIT_OK,
  EXIT_USAGE,
  isTargetRuntime,
  PROGRAM_NAME,
  TARGET_RUNTIMES,
  type TargetRuntime,
  VERSION,
} from '../constants.ts';
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
 * The application entry shared by the Deno, Node, and Bun targets.
 *
 * All three bind a socket through `app.start({ port })`, which delegates to the
 * runtime's Hono serve adapter (M23).
 *
 * @returns The `main.ts` contents
 */
function serveEntry(): string {
  return `import { createApplication } from '@hono-enterprise/kernel';
import { RuntimePlugin } from '@hono-enterprise/runtime';

const app = createApplication({
  plugins: [RuntimePlugin()],
});

app.router.get('/', (ctx) => ctx.response.json({ message: 'Hello, World!' }));

await app.start({ port: 3000 });
`;
}

/**
 * The Cloudflare Workers entry: a `fetch` export, never a `listen`.
 *
 * @returns The `src/index.ts` contents
 */
function workersEntry(): string {
  return `import { createApplication } from '@hono-enterprise/kernel';
import { RuntimePlugin } from '@hono-enterprise/runtime';

const app = createApplication({
  plugins: [RuntimePlugin()],
});

app.router.get('/', (ctx) => ctx.response.json({ message: 'Hello, World!' }));

// Workers have no socket to bind: start() registers the plugins and the
// platform drives the app through fetch().
const ready = app.start();

export default {
  async fetch(request: Request): Promise<Response> {
    await ready;
    return await app.fetch(request);
  },
};
`;
}

/**
 * Builds the file set for one runtime target.
 *
 * @param projectName - The project directory and manifest name
 * @param runtime - The selected runtime target
 * @returns The files to create, relative to the project root
 */
function projectFiles(projectName: string, runtime: TargetRuntime): readonly GeneratedFile[] {
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
            imports: {
              '@hono-enterprise/kernel': `jsr:@hono-enterprise/kernel@${RANGE}`,
              '@hono-enterprise/runtime': `jsr:@hono-enterprise/runtime@${RANGE}`,
              '@hono-enterprise/common': `jsr:@hono-enterprise/common@${RANGE}`,
            },
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
            dependencies: {
              '@hono-enterprise/kernel': `npm:@jsr/hono-enterprise__kernel@${RANGE}`,
              '@hono-enterprise/runtime': `npm:@jsr/hono-enterprise__runtime@${RANGE}`,
              '@hono-enterprise/common': `npm:@jsr/hono-enterprise__common@${RANGE}`,
            },
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
  const usage = `Usage: ${PROGRAM_NAME} new <project-name> [--runtime <target>] [--dir <path>]`;

  // `--help` is never an error.
  if (args.flags['help'] === true || args.flags['h'] === true) {
    deps.log(usage);
    deps.log('');
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

  const projectName = deriveNames(rawName).kebab;
  if (projectName === '') {
    deps.error(`Invalid project name: "${rawName}".`);
    return EXIT_USAGE;
  }

  const root = joinPath(resolveDir(deps.cwd, stringFlag(args.flags, 'dir')), projectName);
  const files = projectFiles(projectName, runtime).map((file) => ({
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
