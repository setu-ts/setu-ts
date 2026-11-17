import type { IFileSystem } from '@setu-ts/common';
import { describe, expect, it } from 'vitest';
import { renderBrief } from '../../../src/agents/render.ts';
import { gatherFacts } from '../../../src/agents/facts.ts';
import { createFakeFs } from '../../fixtures/fake-fs.ts';

describe('read-only project facts', () => {
  it('V12-28 distinguishes schema commands from data migrations', async () => {
    const facts = await gatherFacts(
      createFakeFs({
        '/app/package.json': JSON.stringify({
          scripts: { 'db:generate': 'drizzle-kit generate', 'db:deploy': 'prisma migrate deploy' },
        }),
      }),
      '/app',
    );
    expect(facts.commands).toEqual(['db:generate', 'db:deploy']);
    expect(renderBrief(facts)).toContain(
      'schema migrations; data migrations use setu g migration and src/migrations/run.ts',
    );
  });
  it('V11-9 includes only the present lint and formatting scripts', async () => {
    const facts = await gatherFacts(
      createFakeFs({
        '/app/package.json':
          '{"scripts":{"lint":"eslint .","format":"prettier --write .","format:check":"prettier --check ."}}',
      }),
      '/app',
    );
    expect(facts.commands).toEqual(['lint', 'format', 'format:check']);
  });
  it('includes opt-in client scripts in project commands', async () => {
    const facts = await gatherFacts(
      createFakeFs({
        '/app/package.json': JSON.stringify({
          scripts: { client: 'setu client', 'client:check': 'setu client --check' },
        }),
      }),
      '/app',
    );
    expect(facts.commands).toEqual(['client', 'client:check']);
  });
  it('reads installed packages, style, scripts, seams and optional directories', async () => {
    const fs = createFakeFs({
      '/app/package.json': JSON.stringify({
        dependencies: { '@setu-ts/decorator-plugin': '1' },
        devDependencies: { '@setu-ts/testing': '1' },
        scripts: { start: 'node main.ts', test: 'x', check: 'x', build: 1, extra: 'x' },
      }),
      '/app/src/modules/a.ts': '',
      '/app/src/shared/a.ts': '',
    });
    const facts = await gatherFacts(fs, '/app');
    expect([...facts.installed]).toEqual(['decorator-plugin', 'testing']);
    expect(facts.style).toBe('class-based');
    expect(facts.runtime).toBe('node');
    expect(facts.commands).toEqual(['start', 'check', 'test']);
    expect(facts.directories).toEqual(['src/modules', 'src/shared']);
    // The project has modules, so its controllers live there, not in src/controllers/.
    expect(facts.seams).not.toContain('src/controllers');
    expect(facts.seams).toContain('src/middleware');
    expect(facts.schematics).toContain('controller');
    expect(fs.writes).toEqual([]);
  });
  it('accepts Deno JSONC tasks, Bun and Workers manifests', async () => {
    const deno = await gatherFacts(
      createFakeFs({
        '/app/deno.jsonc':
          '{//comment\n"imports":{"@setu-ts/queue-plugin":"x"},"tasks":{"test":"x","test:e2e":"x","dev":"x","build":"x","db:migrate":"x"}}',
      }),
      '/app',
    );
    expect(deno.runtime).toBe('deno');
    expect(deno.commands).toEqual(['test', 'test:e2e', 'dev', 'build', 'db:migrate']);
    expect(deno.seams).toContain('src/jobs');
    expect(
      (
        await gatherFacts(
          createFakeFs({ '/app/package.json': '{"scripts":{"start":"bun main.ts"}}' }),
          '/app',
        )
      ).runtime,
    ).toBe('bun');
    expect(
      (
        await gatherFacts(
          createFakeFs({ '/app/package.json': '{}', '/app/wrangler.toml': '' }),
          '/app',
        )
      ).runtime,
    ).toBe('cloudflare-workers');
  });
  it('refuses absent, malformed, scalar and array manifests', async () => {
    for (const text of ['bad', 'null', '1', '[]'])
      await expect(
        gatherFacts(createFakeFs({ '/app/package.json': text }), '/app'),
      ).rejects.toThrow('/app/package.json');
    await expect(gatherFacts(createFakeFs(), '/app')).rejects.toThrow('not a project');
  });
  it('surfaces unreadable runtime markers and directory failures', async () => {
    const base = createFakeFs({ '/app/package.json': '{}' });
    const fs: IFileSystem = {
      ...base,
      stat: (path) =>
        path.endsWith('wrangler.jsonc') ? Promise.reject(new Error('denied')) : base.stat(path),
    };
    await expect(gatherFacts(fs, '/app')).rejects.toThrow('wrangler.jsonc');
    await expect(
      gatherFacts(
        {
          ...base,
          stat: (path) =>
            path.includes('src/modules') ? Promise.reject(new Error('denied')) : base.stat(path),
        },
        '/app',
      ),
    ).rejects.toThrow('denied');
  });
  it('does not treat a file as a directory', async () => {
    expect(
      (
        await gatherFacts(
          createFakeFs({ '/app/package.json': '{}', '/app/src/modules': '' }),
          '/app',
        )
      ).directories,
    ).toEqual([]);
  });
});
