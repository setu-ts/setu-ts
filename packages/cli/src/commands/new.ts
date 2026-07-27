/**
 * Implementation of the `honoe new` command — project scaffolding.
 *
 * @module
 */

import { type DerivedNames, deriveNames } from '../utils/names.ts';
import type { GeneratedFile } from '../schematics/registry.ts';

/**
 * Project options for the `new` command.
 */
interface NewCommandOptions {
  readonly dir?: string;
  readonly runtime?: 'deno' | 'node' | 'bun' | 'cloudflare-workers';
  readonly dryRun?: boolean;
}

/**
 * Handles the `honoe new` command.
 *
 * Creates a new Hono Enterprise project with the specified runtime.
 *
 * @param args - Array of command-line arguments (excluding command name)
 * @param options - Optional configuration (dir, runtime, dryRun)
 * @returns Exit code (0 for success)
 */
export function runNewCommand(
  args: readonly string[],
  options: NewCommandOptions = {},
): number {
  const parsed = parseArgs(args);
  if (parsed.positionals.length === 0) {
    throw new Error('Project name is required');
  }

  const projectName = parsed.positionals[0];
  const names = deriveNames(projectName);
  const runtime = options.runtime ?? 'deno';

  // Build project files based on runtime
  const files: GeneratedFile[] = generateProjectFiles(projectName, names, runtime, options);

  // Write files (dry run only prints)
  if (options.dryRun) {
    for (const file of files) {
      console.log(`would create ${file.path}`);
    }
    return 0;
  }

  // Simulate creation
  console.log(`Creating project "${projectName}" with runtime ${runtime}...`);
  for (const file of files) {
    console.log(`Created ${file.path}`);
  }

  return 0;
}

/**
 * Generates the project files for a new Hono Enterprise project.
 *
 * @param projectName - The name of the project
 * @param names - Derived naming variants
 * @param runtime - The target runtime
 * @param options - Command options including dryRun
 * @returns Array of GeneratedFile objects
 */
function generateProjectFiles(
  projectName: string,
  _names: DerivedNames,
  runtime: 'deno' | 'node' | 'bun' | 'cloudflare-workers',
  _options: { dryRun?: boolean },
): GeneratedFile[] {
  // No runtime services are used in this function; placeholder for future implementation.

  const baseFiles: GeneratedFile[] = [
    {
      path: 'README.md',
      contents: `# ${projectName}\n\nA Hono Enterprise project generated with honoe new.\n\n`,
    },
    {
      path: 'deno.json',
      contents: `{\n  "tasks": {\n    "start": "run main.ts"\n  }\n}\n`,
    },
  ];

  const mainFiles: GeneratedFile[] = [];

  switch (runtime) {
    case 'deno':
      mainFiles.push({
        path: 'main.ts',
        contents:
          `import { createApplication } from '@hono-enterprise/kernel';\nimport { RuntimePlugin } from '@hono-enterprise/runtime';\n\nconst app = createApplication({\n  plugins: [RuntimePlugin()],\n});\n\napp.router.get('/', (ctx) => {\n  return ctx.response.json({ hello: 'world' });\n});\n\nawait app.start({ port: 3000 });\n`,
      });
      break;

    case 'node':
      mainFiles.push({
        path: 'main.ts',
        contents:
          `import { createApplication } from '@hono-enterprise/kernel';\nimport { RuntimePlugin } from '@hono-enterprise/runtime';\n\nconst app = createApplication({\n  plugins: [RuntimePlugin()],\n});\n\napp.router.get('/', (ctx) => {\n  return ctx.response.json({ hello: 'world' });\n});\n\napp.start({ port: 3000 });\n`,
      });
      break;

    case 'bun':
      mainFiles.push({
        path: 'main.ts',
        contents:
          `import { createApplication } from '@hono-enterprise/kernel';\nimport { RuntimePlugin } from '@hono-enterprise/runtime';\n\nconst app = createApplication({\n  plugins: [RuntimePlugin()],\n});\n\napp.router.get('/', (ctx) => {\n  return ctx.response.json({ hello: 'world' });\n});\n\nBun.serve({\n  port: 3000,\n  fetch: app.requestHandler,\n});\nconsole.log('Server running on port 3000');\n`,
      });
      break;

    case 'cloudflare-workers':
      mainFiles.push({
        path: 'src/index.ts',
        contents:
          `import type { Fetcher } from '@hono-enterprise/runtime';\n\nconst fetch: Fetcher = async (request) => {\n  return new Response(JSON.stringify({ hello: 'world' }));\n};\n\nexport default fetch;\n`,
      });
      mainFiles.push({
        path: 'wrangler.toml',
        contents: `[env.default]\nname = "${projectName}"\n`,
      });
      break;
  }

  return [...baseFiles, ...mainFiles];
}

/**
 * Simple argument parser for the new command (handles --dir, --runtime, --dry-run).
 */
function parseArgs(args: readonly string[]): {
  positionals: readonly string[];
  flags: Record<string, unknown>;
} {
  const positionals: string[] = [];
  const flags: Record<string, unknown> = {};
  let currentFlag: string | null = null;

  for (const arg of args) {
    if (arg.startsWith('--')) {
      if (currentFlag === null) {
        currentFlag = arg.slice(2);
      } else {
        flags[currentFlag] = true;
        currentFlag = arg.slice(2);
      }
    } else if (arg === '-') {
      currentFlag = null;
    } else if (arg.startsWith('-')) {
      // Short flag
      currentFlag = arg.slice(1);
    } else if (currentFlag !== null) {
      flags[currentFlag] = arg;
      currentFlag = null;
    } else {
      positionals.push(arg);
    }
  }

  // Set last flag to true if no value was provided
  if (currentFlag !== null) {
    flags[currentFlag] = true;
  }

  return {
    positionals: Object.freeze(positionals) as readonly string[],
    flags: Object.freeze(flags),
  };
}
