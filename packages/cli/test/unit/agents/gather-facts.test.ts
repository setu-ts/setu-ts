import type { IFileSystem } from '@setu-ts/common';
import { describe, expect, it } from 'vitest';
import { gatherFacts } from '../../../src/agents/facts.ts';
import { createFakeFs } from '../../fixtures/fake-fs.ts';

describe('read-only project facts', () => {
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
