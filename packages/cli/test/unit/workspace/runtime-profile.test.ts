import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createFakeFs } from '../../fixtures/fake-fs.ts';
import {
  detectProjectRuntime,
  isWorkspaceRuntime,
  WORKSPACE_RUNTIMES,
  workspaceProfile,
} from '../../../src/workspace/runtime-profile.ts';
import { workspaceRootFiles } from '../../../src/workspace/root-files.ts';
import { libraryFiles } from '../../../src/workspace/library.ts';
import { renderDiscoveryModule } from '../../../src/workspace/discovery-module.ts';
import { DOCKERFILE, workspaceContainerFiles } from '../../../src/workspace/compose.ts';
import { renderConnection, transportSpec } from '../../../src/workspace/transport.ts';
import { WORKSPACE_VERSION } from '../../../src/workspace/manifest.ts';
import { deriveNames } from '../../../src/utils/names.ts';

describe('the workspace runtime profiles', () => {
  it('hosts a workspace on deno, node and bun', () => {
    expect(WORKSPACE_RUNTIMES).toEqual(['deno', 'node', 'bun']);
    for (const runtime of WORKSPACE_RUNTIMES) expect(isWorkspaceRuntime(runtime)).toBe(true);
  });

  // Not a missing profile — a topology difference. Each Worker is its own deploy
  // unit with its own wrangler.toml, so several are several deployments.
  it('does not host one on Cloudflare Workers', () => {
    expect(isWorkspaceRuntime('cloudflare-workers')).toBe(false);
  });

  // Measured: `bun install` reads npm `workspaces` from package.json, so there are
  // two root shapes rather than three.
  it('gives node and bun the same manifest shape', () => {
    expect(workspaceProfile('deno').manifestKind).toBe('deno');
    expect(workspaceProfile('node').manifestKind).toBe('npm');
    expect(workspaceProfile('bun').manifestKind).toBe('npm');
    expect(workspaceProfile('bun').globKey).toBe(workspaceProfile('node').globKey);
  });

  // …but not the same commands, and that is the whole reason Bun is its own
  // profile rather than an alias.
  it('gives each runtime its own toolchain commands', () => {
    const commands = WORKSPACE_RUNTIMES.map((runtime) => {
      const profile = workspaceProfile(runtime);
      return `${profile.install}|${profile.runAll}|${profile.lockfile}`;
    });
    expect(new Set(commands).size).toBe(WORKSPACE_RUNTIMES.length);
  });

  // The reason `runScript` exists rather than a branch on `manifestKind`: Bun
  // shares npm's manifest shape and none of its commands, so a next step derived
  // from the shape told a Bun developer to run `npm start` immediately after
  // telling them to run `bun install`.
  it('runs a named script with its own toolchain, Bun included', () => {
    expect(workspaceProfile('deno').runScript('start')).toBe('deno task start');
    expect(workspaceProfile('node').runScript('start')).toBe('npm run start');
    expect(workspaceProfile('bun').runScript('start')).toBe('bun run start');
    expect(workspaceProfile('bun').runScript('dev')).not.toContain('npm');
  });

  // The one thing a generated module cannot express portably.
  it('reads the environment the way its runtime can', () => {
    expect(workspaceProfile('deno').envRead('X', 'd')).toContain(`Deno.env.get('X')`);
    for (const runtime of ['node', 'bun'] as const) {
      const read = workspaceProfile(runtime).envRead('X', 'd');
      expect(read).toContain('process.env.X');
      expect(read).not.toContain('Deno.');
    }
  });
});

describe('detectProjectRuntime', () => {
  it('reads a Deno project from its manifest', async () => {
    const fs = createFakeFs({ '/p/deno.json': '{}' });
    expect(await detectProjectRuntime(fs, '/p')).toBe('deno');
  });

  // The manifest is identical for both, so the LOCKFILE is what tells them apart.
  it('tells node and bun apart by the lockfile', async () => {
    const node = createFakeFs({ '/p/package.json': '{}', '/p/package-lock.json': '{}' });
    expect(await detectProjectRuntime(node, '/p')).toBe('node');
    const bun = createFakeFs({ '/p/package.json': '{}', '/p/bun.lock': '' });
    expect(await detectProjectRuntime(bun, '/p')).toBe('bun');
  });

  // A project that has never been installed still has to convert, and npm's root
  // shape is what Bun reads too — so the workspace works either way.
  it('defaults an uninstalled npm project to node', async () => {
    const fs = createFakeFs({ '/p/package.json': '{}' });
    expect(await detectProjectRuntime(fs, '/p')).toBe('node');
  });

  it('defaults a directory with neither manifest to deno', async () => {
    expect(await detectProjectRuntime(createFakeFs({}), '/p')).toBe('deno');
  });
});

describe('what an npm workspace renders', () => {
  const NODE = workspaceProfile('node');
  const HTTP = transportSpec('http');

  /**
   * Reads one generated root file.
   *
   * @param path - Its path
   * @returns The contents, or an empty string
   */
  function rootFile(path: string): string {
    return workspaceRootFiles('acme', 3000, HTTP, NODE)
      .find((file) => file.path === path)?.contents ?? '';
  }

  it('declares members in package.json, not deno.json', () => {
    const manifest = JSON.parse(rootFile('package.json')) as {
      workspaces?: string[];
      private?: boolean;
      scripts?: Record<string, string>;
    };
    // npm matches globs as written; the `./` Deno takes would match nothing.
    expect(manifest.workspaces).toEqual(['apps/*', 'libs/*']);
    // npm refuses to treat a manifest as a workspace root without it.
    expect(manifest.private).toBe(true);
    expect(manifest.scripts?.['dev']).toBe(NODE.runAll);
    expect(rootFile('deno.json')).toBe('');
  });

  // Without it `npm install` cannot resolve a single framework package: they come
  // from JSR through npm compatibility. Measured in a real two-member workspace.
  it('maps the @jsr scope at the root', () => {
    expect(rootFile('.npmrc')).toContain('@jsr:registry=https://npm.jsr.io');
  });

  // Bun installs into each member too, so an ignore naming only the root would
  // commit them.
  it('ignores node_modules in both places', () => {
    const ignore = rootFile('.gitignore');
    expect(ignore).toContain('node_modules/');
    expect(ignore).toContain('apps/*/node_modules/');
  });

  it('records the runtime, so every later command reads it back', () => {
    const manifest = JSON.parse(rootFile('setu.workspace.json')) as { runtime?: string };
    expect(manifest.runtime).toBe('node');
  });

  // The generated module is emitted into a Node member, where `Deno` does not
  // exist — this was the single largest blocker to npm workspaces.
  it('reads sibling hosts through process.env', () => {
    const module = renderDiscoveryModule(
      { name: 'orders', port: 3000 },
      [{ name: 'orders', port: 3000 }, { name: 'billing', port: 3001 }],
      NODE,
    );
    expect(module).toContain('process.env.BILLING_HOST');
    expect(module).not.toContain('Deno.env');
  });

  it('reads a transport connection through process.env too', () => {
    const redis = transportSpec('redis').connection;
    expect(renderConnection(redis!, NODE)).toContain('process.env.REDIS_URL');
    expect(renderConnection(redis!, NODE)).not.toContain('Deno.env');
  });

  // A library carrying a deno.json inside an npm workspace is invisible to every
  // member that would import it.
  it('gives a library the manifest its workspace can resolve', () => {
    const files = libraryFiles('acme', deriveNames('shared'), NODE);
    const paths = files.map((file) => file.path);
    expect(paths).toContain('libs/shared/package.json');
    expect(paths).not.toContain('libs/shared/deno.json');

    const manifest = JSON.parse(
      files.find((file) => file.path === 'libs/shared/package.json')?.contents ?? '{}',
    ) as { name?: string; exports?: unknown; main?: string };
    expect(manifest.name).toBe('@acme/shared');
    expect(manifest.exports).toEqual({ '.': './src/index.ts' });
    expect(manifest.main).toBe('./src/index.ts');
  });

  // …and a test it can actually run: `@std/testing` in a Node library would need a
  // JSR dependency nothing else there uses.
  it('gives a library its own toolchain test runner', () => {
    const test = libraryFiles('acme', deriveNames('shared'), NODE)
      .find((file) => file.path.endsWith('.test.ts'))?.contents ?? '';
    expect(test).toContain(`from 'node:test'`);
    expect(test).not.toContain('@std/testing');
  });

  it('builds members on a Node base image, installing from the root', () => {
    const dockerfile = workspaceContainerFiles(
      {
        version: WORKSPACE_VERSION,
        runtime: 'node',
        basePort: 3000,
        transport: 'http',
        members: [
          { name: 'orders', port: 3000 },
        ],
      },
      HTTP,
      NODE,
    ).find((file) => file.path === DOCKERFILE)?.contents ?? '';

    expect(dockerfile).toContain('FROM node:');
    expect(dockerfile).not.toContain('denoland/deno');
    // The install runs at the ROOT, because both npm and Bun resolve a member's
    // dependencies through the root manifest and lockfile.
    expect(dockerfile).toContain(NODE.install);
    expect(dockerfile).toContain('COPY package.json');
    // Without the scope mapping the install resolves no framework package at all.
    expect(dockerfile).toContain('.npmrc');
    // Shared libraries BEFORE the install, not after: a member that depends on one
    // is linked by the install itself, so a library arriving later is a dependency
    // the install could not resolve.
    expect(dockerfile.indexOf('COPY lib[s]')).toBeGreaterThan(-1);
    expect(dockerfile.indexOf('COPY lib[s]')).toBeLessThan(dockerfile.indexOf(NODE.install));
    // Numeric for the same reason every other image here is.
    expect(dockerfile).toMatch(/^USER \d+:\d+$/m);
  });
});

// Bun shares npm's ROOT shape but not its commands, its lockfile, its install
// layout, its base image or its test runner — so every one of those is rendered
// here rather than assumed to follow from the shared manifest kind.
describe('what a Bun workspace renders differently', () => {
  const BUN = workspaceProfile('bun');
  const HTTP = transportSpec('http');

  it('keeps npm root shape while changing every command', () => {
    const root = workspaceRootFiles('acme', 3000, HTTP, BUN)
      .find((file) => file.path === 'package.json')?.contents ?? '';
    const manifest = JSON.parse(root) as {
      workspaces?: string[];
      scripts?: Record<string, string>;
    };
    expect(manifest.workspaces).toEqual(['apps/*', 'libs/*']);
    expect(manifest.scripts?.['dev']).toBe('bun scripts/dev.mjs');
    expect(manifest.scripts?.['dev']).not.toContain('npm');
  });

  it('builds on the Bun image and installs with Bun', () => {
    const dockerfile = workspaceContainerFiles(
      {
        version: WORKSPACE_VERSION,
        runtime: 'bun',
        basePort: 3000,
        transport: 'http',
        members: [{ name: 'orders', port: 3000 }],
      },
      HTTP,
      BUN,
    ).find((file) => file.path === DOCKERFILE)?.contents ?? '';

    expect(dockerfile).toContain('FROM oven/bun');
    expect(dockerfile).toContain('bun install');
    // Bun's own lockfile, so the copy that seeds the install layer finds one.
    expect(dockerfile).toContain(BUN.lockfile);
    expect(dockerfile).toContain('bun run main.ts');
    expect(dockerfile).not.toContain('tsx');
  });

  it('gives a Bun library Bun types and Bun test', () => {
    const files = libraryFiles('acme', deriveNames('shared'), BUN);
    const manifest = JSON.parse(
      files.find((file) => file.path === 'libs/shared/package.json')?.contents ?? '{}',
    ) as { scripts?: Record<string, string>; devDependencies?: Record<string, string> };
    expect(manifest.scripts?.['test']).toBe('bun test');
    expect(manifest.devDependencies?.['@types/bun']).toBeDefined();
    expect(manifest.devDependencies?.['tsx']).toBeUndefined();
  });

  // Every profile's own renderers, so none is declared and left unread — including
  // the Workers entry, which exists only to keep the lookup total.
  it('renders a glob and an environment read for every profile', () => {
    for (const runtime of ['deno', 'node', 'bun', 'cloudflare-workers'] as const) {
      const profile = workspaceProfile(runtime);
      expect(profile.memberGlob('apps')).toContain('apps/');
      expect(profile.envRead('X', 'd')).toContain('X');
      expect(profile.runScript('start')).toContain('start');
      expect(profile.rootManifestFile.endsWith('.json')).toBe(true);
    }
  });
});
