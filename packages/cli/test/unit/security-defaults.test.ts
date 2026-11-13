import { describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli.ts';
import { projectFiles, resolveHost } from '../../src/templates/project-files.ts';
import { getTemplate } from '../../src/templates/registry.ts';
import { MINIMAL_HOST } from '../../src/templates/minimal.ts';
import { generateSecret } from '../../src/templates/secret.ts';
import {
  exactFrameworkSpecifier,
  frameworkSpecifier,
} from '../../src/templates/framework-specifier.ts';
import { VERSION } from '../../src/version.ts';
import { rootManifestSettings } from '../../src/templates/root-settings.ts';
import { createFakeFs } from '../fixtures/fake-fs.ts';
import { generateSse } from '../../src/schematics/sse.ts';
import { moduleSchemas } from '../../src/schematics/module-files.ts';
import { deriveNames } from '../../src/utils/names.ts';
import { options as schematicOptions } from './schematics/_shared.ts';

describe('M140a scaffold security defaults', () => {
  it('generates a fresh 256-bit lowercase hex secret per call', () => {
    const first = generateSecret();
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(generateSecret()).not.toBe(first);
  });
  for (const runtime of ['node', 'bun', 'deno', 'cloudflare-workers'] as const) {
    for (const name of ['minimal', 'rest', 'full-stack'] as const) {
      it(`ignores local dependencies and secrets in ${runtime}/${name}`, () => {
        const host = resolveHost(name === 'minimal' ? MINIMAL_HOST : getTemplate(name)!, runtime);
        const files = projectFiles('shop', runtime, host, undefined, {
          secret: () => 'a'.repeat(64),
        });
        const ignore = files.find((file) => file.path === '.gitignore')!.contents.split('\n');
        expect(ignore).toEqual(
          expect.arrayContaining(['node_modules/', '.env', '.env.*', '!.env.example']),
        );
        if (runtime === 'cloudflare-workers')
          expect(ignore).toEqual(
            expect.arrayContaining(['.dev.vars', '.dev.vars.*', '!.dev.vars.example']),
          );
        if (name === 'full-stack') {
          const envFile = runtime === 'cloudflare-workers' ? '.dev.vars' : '.env';
          expect(files.find((file) => file.path === envFile)!.contents).toContain(
            `SESSION_SECRET=${'a'.repeat(64)}`,
          );
          expect(files.find((file) => file.path === `${envFile}.example`)!.contents).toMatch(
            /SESSION_SECRET=\n/,
          );
          if (runtime !== 'cloudflare-workers')
            expect(files.find((file) => file.path === 'README.md')!.contents).toContain(
              '-e SESSION_SECRET shop',
            );
        }
      });
    }
  }

  it('uses the injected secret in new and keeps dry-run output value-free', async () => {
    const fs = createFakeFs();
    const lines: string[] = [];
    const secret = 'injected-local-secret-at-least-32-characters';
    const deps = {
      fs,
      cwd: '/work',
      now: () => 0,
      log: (line: string) => {
        lines.push(line);
      },
      error: (line: string) => {
        throw new Error(line);
      },
      secret: () => secret,
    };
    expect(await runCli(['new', 'shop', '--template', 'full-stack'], deps)).toBe(0);
    expect(fs.read('/work/shop/.env')).toContain(`SESSION_SECRET=${secret}`);
    expect(await runCli(['new', 'dry', '--template', 'full-stack', '--dry-run'], deps)).toBe(0);
    expect(lines.join('\n')).not.toContain(secret);
    expect(fs.has('/work/dry/.env')).toBe(false);
  });

  it('creates different default secrets for two scaffolds and threads the injected member secret', async () => {
    const fs = createFakeFs();
    const deps = {
      fs,
      cwd: '/work',
      now: () => 0,
      log: () => {},
      error: (line: string) => {
        throw new Error(line);
      },
    };
    for (const name of ['first', 'second'])
      expect(await runCli(['new', name, '--template', 'full-stack'], deps)).toBe(0);
    expect(fs.read('/work/first/.env')).not.toBe(fs.read('/work/second/.env'));
    expect(await runCli(['new', 'workspace', '--workspace'], deps)).toBe(0);
    expect(
      await runCli(['g', 'app', 'web', '--template', 'full-stack'], {
        ...deps,
        cwd: '/work/workspace',
        secret: () => 'b'.repeat(64),
      }),
    ).toBe(0);
    expect(fs.read('/work/workspace/apps/web/.env')).toContain(`SESSION_SECRET=${'b'.repeat(64)}`);
  });

  it.each(['node', 'cloudflare-workers'] as const)(
    'adds an ignored session secret once on %s',
    async (runtime) => {
      const fs = createFakeFs();
      const deps = {
        fs,
        cwd: '/work',
        now: () => 0,
        log: () => {},
        error: (line: string) => {
          throw new Error(line);
        },
        secret: () => 'c'.repeat(64),
      };
      expect(await runCli(['new', 'shop', '--template', 'rest', '--runtime', runtime], deps)).toBe(
        0,
      );
      const projectDeps = { ...deps, cwd: '/work/shop' };
      expect(await runCli(['add', 'session'], projectDeps)).toBe(0);
      const file = `/work/shop/${runtime === 'node' ? '.env' : '.dev.vars'}`;
      const before = fs.read(file);
      expect(before).toContain(`SESSION_SECRET=${'c'.repeat(64)}`);
      expect(fs.read(`${file}.example`)).toContain('SESSION_SECRET=\n');
      expect(
        await runCli(['add', 'session'], { ...projectDeps, secret: () => 'd'.repeat(64) }),
      ).toBe(0);
      expect(fs.read(file)).toBe(before);
    },
  );

  it.each([
    ['node', '/work/shop/.env'],
    ['deno', undefined],
  ] as const)(
    'add auth in a %s project whose config declares no dotenv file',
    async (runtime, written) => {
      const fs = createFakeFs();
      const lines: string[] = [];
      const deps = {
        fs,
        cwd: '/work',
        now: () => 0,
        log: (line: string) => {
          lines.push(line);
        },
        error: (line: string) => {
          throw new Error(line);
        },
        secret: () => 'e'.repeat(64),
      };
      expect(await runCli(['new', 'shop', '--runtime', runtime], deps)).toBe(0);
      expect(await runCli(['add', 'auth'], { ...deps, cwd: '/work/shop' })).toBe(0);
      if (written !== undefined) {
        expect(fs.read(written)).toContain(`JWT_SECRET=${'e'.repeat(64)}`);
        expect(fs.read(`${written}.example`)).toContain('JWT_SECRET=\n');
      } else {
        expect(fs.has('/work/shop/.env')).toBe(false);
        expect(lines.join('\n')).toContain(
          "Set JWT_SECRET in the environment: this project's config declares no dotenv file",
        );
      }
    },
  );

  it('keeps a custom env file ignored and its example tracked', async () => {
    const fs = createFakeFs();
    const deps = {
      fs,
      cwd: '/work',
      now: () => 0,
      log: () => {},
      error: (line: string) => {
        throw new Error(line);
      },
    };
    expect(
      await runCli(['new', 'shop', '--template', 'rest', '--env-file', '.env.local'], deps),
    ).toBe(0);
    const ignore = fs.read('/work/shop/.gitignore').split('\n');
    expect(ignore).toEqual(expect.arrayContaining(['.env.*', '.env.local', '!.env.local.example']));
    // Git applies the last matching pattern: the example's negation follows `.env.*`.
    expect(ignore.lastIndexOf('!.env.local.example')).toBeGreaterThan(ignore.indexOf('.env.*'));
  });

  it('emits the exact check CLI, a one-day third-party cooldown, and a script-free Deno install', () => {
    expect(exactFrameworkSpecifier('cli')).toBe(`npm:@setu-ts/cli@${VERSION}`);
    expect(frameworkSpecifier('cli', 'deno')).toBe(`npm:@setu-ts/cli@^${VERSION}`);
    expect(rootManifestSettings()['minimumDependencyAge']).toEqual({
      age: 'P1D',
      exclude: ['npm:@setu-ts/*'],
    });
    const files = projectFiles('shop', 'deno', resolveHost(getTemplate('full-stack')!, 'deno'));
    const manifest = JSON.parse(files.find((file) => file.path === 'deno.json')!.contents);
    expect(manifest.tasks.install).toBe('deno install');
    expect(manifest.tasks.start).not.toContain('build');
    expect(manifest.tasks.check).toContain(`npm:@setu-ts/cli@${VERSION} check`);
  });

  it('bounds generated module names and ids, and keeps the SSE connection in both styles', () => {
    const names = deriveNames('updates');
    expect(moduleSchemas(names)).toContain('name: z.string().min(1).max(200)');
    expect(moduleSchemas(names)).toContain('id: z.string().min(1).max(128)');
    for (const plugins of [new Set<string>(), new Set(['decorator-plugin'])]) {
      const controller = generateSse(names, { ...schematicOptions(), plugins }).find((file) =>
        file.path.endsWith('.controller.ts'),
      )!.contents;
      expect(controller).toContain("conn.send({ event: 'ready', data: {} });");
      expect(controller).toContain('return conn.result;');
      expect(controller).toContain('sse.channel(name)');
    }
  });
});
