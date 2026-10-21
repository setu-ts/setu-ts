import { describe, expect, it } from 'vitest';
import { cardWarnings } from '../../../src/agents/card-presence.ts';
import { createFakeFs } from '../../fixtures/fake-fs.ts';

describe('advisory card checks', () => {
  const installed = new Set(['common']);
  it('finds hoisted-only cards for a workspace member without warning', async () => {
    const fs = createFakeFs({
      '/work/node_modules/@setu-ts/common/AGENT_CARD.md': '# Common',
      '/work/apps/a/deno.json': '{}',
    });
    expect(await cardWarnings(fs, '/work/apps/a', installed, '/work')).toEqual([]);
  });
  it('finds member-local-only cards before looking at the workspace root', async () => {
    const fs = createFakeFs({
      '/work/apps/a/node_modules/@setu-ts/common/AGENT_CARD.md': '# Common',
    });
    const reads: string[] = [];
    expect(
      await cardWarnings(
        {
          ...fs,
          stat: (path) => {
            reads.push(path);
            return fs.stat(path);
          },
        },
        '/work/apps/a',
        installed,
        '/work',
      ),
    ).toEqual([]);
    expect(reads).not.toContain('/work/node_modules/@setu-ts/common/AGENT_CARD.md');
  });
  it('warns once when neither member-local nor hoisted cards exist', async () => {
    const fs = createFakeFs();
    const reads: string[] = [];
    expect(
      await cardWarnings(
        {
          ...fs,
          stat: (path) => {
            reads.push(path);
            return fs.stat(path);
          },
        },
        '/work/apps/a',
        installed,
        '/work',
      ),
    ).toEqual(['card not found: ../../node_modules/@setu-ts/common/AGENT_CARD.md — run install']);
    expect(reads.filter((path) => path.endsWith('AGENT_CARD.md'))).toEqual([
      '/work/apps/a/node_modules/@setu-ts/common/AGENT_CARD.md',
      '/work/node_modules/@setu-ts/common/AGENT_CARD.md',
    ]);
  });
  it('reports missing cards and stays quiet when present', async () => {
    expect(await cardWarnings(createFakeFs(), '/app', installed)).toEqual([
      'card not found: node_modules/@setu-ts/common/AGENT_CARD.md — run install',
    ]);
    expect(
      await cardWarnings(
        createFakeFs({ '/app/node_modules/@setu-ts/common/AGENT_CARD.md': '# Common' }),
        '/app',
        installed,
      ),
    ).toEqual([]);
  });
  it('names the PnP setting, including implicit nodeLinker with a pnp loader', async () => {
    for (const seed of [{ '/app/.yarnrc.yml': 'nodeLinker: pnp' }, { '/app/.pnp.cjs': '' }])
      expect((await cardWarnings(createFakeFs(seed), '/app', installed))[0]).toContain(
        'nodeLinker: node-modules',
      );
    expect(
      (
        await cardWarnings(
          createFakeFs({ '/app/.yarnrc.yml': 'nodeLinker: node-modules', '/app/.pnp.cjs': 'x' }),
          '/app',
          installed,
        )
      )[0],
    ).toContain('card not found:');
  });
  it('names Deno nodeModulesDir only when absent and no node_modules exists', async () => {
    for (const file of ['deno.json', 'deno.jsonc'])
      expect(
        (await cardWarnings(createFakeFs({ [`/app/${file}`]: '{}' }), '/app', installed))[0],
      ).toContain('"nodeModulesDir": "auto"');
    for (const text of ['{"nodeModulesDir":"auto"}', 'null', '"scalar"'])
      expect(
        (await cardWarnings(createFakeFs({ '/app/deno.json': text }), '/app', installed))[0],
      ).toContain('card not found:');
  });
  it('surfaces real I/O errors rather than treating them as absence', async () => {
    const fs = createFakeFs();
    await expect(
      cardWarnings(
        { ...fs, stat: () => Promise.reject(new Error('stat denied')) },
        '/app',
        installed,
      ),
    ).rejects.toThrow('stat denied');
    await fs.writeFile('/app/.yarnrc.yml', new TextEncoder().encode('nodeLinker: pnp'));
    await expect(
      cardWarnings(
        { ...fs, readFile: () => Promise.reject(new Error('read denied')) },
        '/app',
        installed,
      ),
    ).rejects.toThrow('read denied');
    await fs.mkdir('/app/node_modules');
    await expect(
      cardWarnings(
        {
          ...fs,
          stat: (path) =>
            path.endsWith('AGENT_CARD.md')
              ? Promise.reject(new Error('card denied'))
              : fs.stat(path),
        },
        '/app',
        installed,
      ),
    ).rejects.toThrow('card denied');
  });
  it('gives a Deno workspace member install advice when the root already sets nodeModulesDir', async () => {
    // A member may not declare nodeModulesDir (Deno refuses it there), so the
    // member's own manifest is the wrong place to look.
    const fs = createFakeFs({
      '/work/deno.json': '{ "nodeModulesDir": "auto" }',
      '/work/apps/a/deno.json': '{}',
    });
    expect(await cardWarnings(fs, '/work/apps/a', installed, '/work')).toEqual([
      'card not found: ../../node_modules/@setu-ts/common/AGENT_CARD.md — run install',
    ]);
  });
  it("detects Plug'n'Play by the presence of .pnp.cjs without reading it", async () => {
    const fs = createFakeFs({ '/app/.pnp.cjs': 'x'.repeat(16) });
    const opened: string[] = [];
    const warnings = await cardWarnings(
      {
        ...fs,
        readFile: (path) => {
          opened.push(path);
          return fs.readFile(path);
        },
      },
      '/app',
      installed,
    );
    expect(warnings).toEqual([
      'cards require node_modules — set nodeLinker: node-modules and run install',
    ]);
    expect(opened.filter((path) => path.endsWith('.pnp.cjs'))).toEqual([]);
  });
  it('treats a special or overlarge .yarnrc.yml as unreadable instead of opening it', async () => {
    const fs = createFakeFs({ '/app/.yarnrc.yml': 'nodeLinker: pnp' });
    const opened: string[] = [];
    const warnings = await cardWarnings(
      {
        ...fs,
        stat: (path) =>
          path.endsWith('.yarnrc.yml')
            ? Promise.resolve({ isFile: false, isDirectory: false, size: 0 })
            : fs.stat(path),
        readFile: (path) => {
          opened.push(path);
          return fs.readFile(path);
        },
      },
      '/app',
      installed,
    );
    expect(opened.filter((path) => path.endsWith('.yarnrc.yml'))).toEqual([]);
    expect(warnings).toEqual([
      'card not found: node_modules/@setu-ts/common/AGENT_CARD.md — run install',
    ]);
  });
  it('expects no card from a tooling package', async () => {
    const fs = createFakeFs({ '/app/node_modules/@setu-ts/common/AGENT_CARD.md': '# Common' });
    expect(await cardWarnings(fs, '/app', new Set(['common', 'cli', 'create']))).toEqual([]);
  });
});
