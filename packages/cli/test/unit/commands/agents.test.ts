import type { IFileSystem } from '@setu-ts/common';
import { describe, expect, it } from 'vitest';
import { runCli } from '../../../src/cli.ts';
import { createFakeFs, createRecorder } from '../../fixtures/fake-fs.ts';
import { BRIEF_BEGIN, BRIEF_END } from '../../../src/agents/brief-file.ts';

function harness(
  seed: Readonly<Record<string, string>> = { '/work/package.json': '{}' },
  fsOverride?: (fs: IFileSystem) => IFileSystem,
) {
  const fs = createFakeFs(seed);
  const out = createRecorder();
  const err = createRecorder();
  return {
    fs,
    out,
    err,
    run: (args: readonly string[], interrupt?: AbortSignal) =>
      runCli(args, {
        fs: fsOverride?.(fs) ?? fs,
        cwd: '/work',
        now: () => 0,
        log: out.sink,
        error: err.sink,
        ...(interrupt === undefined ? {} : { interrupt }),
      }),
  };
}

describe('setu agents', () => {
  it('uses both workspace card locations when invoked from a member', async () => {
    for (const location of ['node_modules', 'apps/a/node_modules', undefined]) {
      const h = harness({
        '/work/setu.workspace.json': JSON.stringify({
          version: 1,
          basePort: 3000,
          runtime: 'node',
          transport: 'http',
          members: [{ name: 'a', port: 3000 }],
        }),
        '/work/apps/a/package.json': JSON.stringify({
          dependencies: { '@setu-ts/common': '0.9.0' },
        }),
        ...(location === undefined
          ? {}
          : { [`/work/${location}/@setu-ts/common/AGENT_CARD.md`]: '# Common' }),
      });
      expect(await h.run(['agents', '--dir', 'apps/a'])).toBe(0);
      expect(h.fs.read('/work/apps/a/AGENTS.md')).toContain(
        '| ../../node_modules/@setu-ts/common/AGENT_CARD.md |',
      );
      expect(h.err.lines).toEqual(
        location === undefined
          ? ['card not found: ../../node_modules/@setu-ts/common/AGENT_CARD.md — run install']
          : [],
      );
    }
  });
  it('has help and strict flags, positional arity and exclusive modes', async () => {
    const h = harness();
    for (const flag of ['--help', '-h']) expect(await h.run(['agents', flag])).toBe(0);
    for (const args of [['--bogus'], ['extra'], ['--dir'], ['--check', '--dry-run']])
      expect(await h.run(['agents', ...args])).toBe(2);
    expect(h.fs.writes).toEqual([]);
  });
  it('refuses outside a project, bad manifests and unreadable runtime markers without writes', async () => {
    const none = harness({});
    expect(await none.run(['agents'])).toBe(2);
    for (const text of ['broken', 'null']) {
      const h = harness({ '/work/package.json': text });
      expect(await h.run(['agents'])).toBe(1);
      expect(h.err.text()).toContain('/work/package.json');
      expect(h.fs.writes).toEqual([]);
    }
    const denied = harness(undefined, (fs) => ({
      ...fs,
      readFile: (p) =>
        p.endsWith('wrangler.jsonc') ? Promise.reject(new Error('denied')) : fs.readFile(p),
    }));
    expect(await denied.run(['agents'])).toBe(1);
    expect(denied.err.text()).toContain('wrangler.jsonc');
  });
  it('dry-runs resolved paths without touching any file', async () => {
    const h = harness({ '/work/app/package.json': '{}' });
    expect(await h.run(['agents', '--dir', 'app', '--dry-run'])).toBe(0);
    expect(h.out.text()).toContain('would write /work/app/AGENTS.md');
    expect(h.fs.writes).toEqual([]);
  });
  it('creates, preserves personal bytes, checks freshness and refuses malformed ownership', async () => {
    const h = harness({ '/work/package.json': '{}', '/work/AGENTS.md': 'personal\r\né' });
    expect(await h.run(['agents', '--check'])).toBe(1);
    expect(await h.run(['agents'])).toBe(0);
    expect(h.fs.read('/work/AGENTS.md')).toMatch(/personal\r\né$/);
    expect(await h.run(['agents', '--check'])).toBe(0);
    await h.fs.writeFile(
      '/work/AGENTS.md',
      new TextEncoder().encode(h.fs.read('/work/AGENTS.md').replace('# Setu-TS', '# Edited')),
    );
    const count = h.fs.writes.length;
    expect(await h.run(['agents', '--check'])).toBe(1);
    expect(h.fs.writes.length).toBe(count);
    await h.fs.writeFile('/work/AGENTS.md', new TextEncoder().encode(BRIEF_END + BRIEF_BEGIN));
    expect(await h.run(['agents'])).toBe(1);
    expect(h.err.text()).toContain('/work/AGENTS.md: end marker precedes begin marker');
  });
  it('writes from new only when requested, for standalone and empty workspaces', async () => {
    for (const workspace of [false, true]) {
      const h = harness({});
      expect(await h.run(['new', 'app', '--agents', ...(workspace ? ['--workspace'] : [])])).toBe(
        0,
      );
      expect(h.fs.has('/work/app/AGENTS.md')).toBe(true);
    }
    const h = harness({});
    expect(await h.run(['new', 'app'])).toBe(0);
    expect(h.fs.has('/work/app/AGENTS.md')).toBe(false);
  });
  it('uses one workspace root from any descendant and checks every member', async () => {
    const h = harness({
      '/work/setu.workspace.json': JSON.stringify({
        version: 1,
        runtime: 'node',
        basePort: 3000,
        transport: 'http',
        members: [
          { name: 'a', port: 3000 },
          { name: 'b', port: 3001, dependsOn: ['a'] },
        ],
      }),
      '/work/apps/a/package.json': '{}',
      '/work/apps/b/package.json': '{}',
    });
    expect(await h.run(['agents', '--dir', 'apps/a/src/nested'])).toBe(0);
    for (const path of ['/work/AGENTS.md', '/work/apps/a/AGENTS.md', '/work/apps/b/AGENTS.md'])
      expect(h.fs.has(path)).toBe(true);
    expect(h.fs.read('/work/apps/a/AGENTS.md')).toContain('../../AGENTS.md');
    expect(await h.run(['agents', '--check'])).toBe(0);
    await h.fs.rm('/work/apps/b/AGENTS.md');
    expect(await h.run(['agents', '--check', '--dir', 'apps/a'])).toBe(1);
    expect(h.err.text()).toContain('/work/apps/b/AGENTS.md');
  });
  it('validates every workspace member and every marker before writing', async () => {
    for (const text of ['bad', '{}']) {
      const h = harness({ '/work/setu.workspace.json': text });
      expect(await h.run(['agents'])).toBe(1);
      expect(h.err.text()).toContain('setu.workspace.json');
      expect(h.fs.writes).toEqual([]);
    }
    const h = harness({
      '/work/setu.workspace.json': JSON.stringify({
        version: 1,
        basePort: 3000,
        transport: 'http',
        members: [{ name: 'a', port: 3000 }],
      }),
      '/work/apps/a/package.json': '{}',
      '/work/apps/a/AGENTS.md': BRIEF_BEGIN,
    });
    expect(await h.run(['agents'])).toBe(1);
    expect(h.fs.writes).toEqual([]);
  });
  it('rolls back an interrupted write and surfaces unreadable briefs', async () => {
    const controller = new AbortController();
    const h = harness(undefined, (fs) => ({
      ...fs,
      writeFile: async (p, data) => {
        await fs.writeFile(p, data);
        controller.abort();
      },
    }));
    expect(await h.run(['agents'], controller.signal)).toBe(130);
    expect(h.fs.has('/work/AGENTS.md')).toBe(false);
    const denied = harness({ '/work/package.json': '{}', '/work/AGENTS.md': 'personal' }, (fs) => ({
      ...fs,
      readFile: (p) => (p.endsWith('AGENTS.md') ? Promise.reject('brief denied') : fs.readFile(p)),
    }));
    expect(await denied.run(['agents'])).toBe(1);
    expect(denied.err.text()).toContain('brief denied');
  });
  it('emits the add hint only after a successful add with a sectioned brief', async () => {
    for (const brief of ['', 'personal', BRIEF_BEGIN]) {
      const h = harness({ '/work/package.json': '{}', '/work/AGENTS.md': brief });
      expect(await h.run(['add', 'cache'])).toBe(0);
      const hint = /agents` to update AGENTS\.md\./;
      expect(hint.test(h.out.text())).toBe(brief === BRIEF_BEGIN);
      if (brief === BRIEF_BEGIN) {
        const count = h.out.text().split('to update AGENTS.md.').length;
        expect(await h.run(['add', 'cache'])).toBe(0);
        expect(h.out.text().split('to update AGENTS.md.').length).toBe(count + 1);
      }
    }
  });
  it('preserves a UTF-8 BOM outside the section and refuses special or overlarge files', async () => {
    const h = harness({ '/work/package.json': '{}', '/work/AGENTS.md': '\uFEFFpersonal' });
    expect(await h.run(['agents'])).toBe(0);
    expect(h.fs.read('/work/AGENTS.md')).toContain('\uFEFFpersonal');
    for (const stat of [
      { isFile: false, isDirectory: true, size: 0 },
      { isFile: true, isDirectory: false, size: 2 ** 21 },
    ]) {
      const refused = harness(undefined, (fs) => ({
        ...fs,
        stat: (path) => (path.endsWith('AGENTS.md') ? Promise.resolve(stat) : fs.stat(path)),
      }));
      expect(await refused.run(['agents'])).toBe(1);
      expect(refused.err.text()).toContain('regular file at most 1 MiB');
      expect(refused.fs.writes).toEqual([]);
    }
  });
  it('names the pinned CLI invocation in the add hint', async () => {
    const h = harness({ '/work/package.json': '{}', '/work/AGENTS.md': BRIEF_BEGIN });
    expect(await h.run(['add', 'cache'])).toBe(0);
    expect(h.out.text()).toMatch(/Run `npx @setu-ts\/cli@[^ `]+ agents` to update AGENTS\.md\./);
  });
  it('never opens a special or overlarge AGENTS.md for the add hint', async () => {
    for (const stat of [
      { isFile: false, isDirectory: false, size: 0 },
      { isFile: true, isDirectory: false, size: 2 ** 21 },
    ]) {
      const opened: string[] = [];
      const h = harness({ '/work/package.json': '{}', '/work/AGENTS.md': BRIEF_BEGIN }, (fs) => ({
        ...fs,
        stat: (path) => (path.endsWith('AGENTS.md') ? Promise.resolve(stat) : fs.stat(path)),
        readFile: (path) => {
          if (path.endsWith('AGENTS.md')) opened.push(path);
          return fs.readFile(path);
        },
      }));
      expect(await h.run(['add', 'cache'])).toBe(0);
      expect(opened).toEqual([]);
      expect(h.err.text()).toContain('Cannot inspect AGENTS.md');
    }
  });
  it('reports an unreadable add-hint file without hiding the successful add', async () => {
    const h = harness({ '/work/package.json': '{}', '/work/AGENTS.md': BRIEF_BEGIN }, (fs) => ({
      ...fs,
      readFile: (p) =>
        p.endsWith('AGENTS.md') ? Promise.reject(new Error('denied')) : fs.readFile(p),
    }));
    expect(await h.run(['add', 'cache'])).toBe(0);
    expect(h.err.text()).toContain('Cannot inspect AGENTS.md');
  });
  it('propagates a new --agents writer failure after scaffolding', async () => {
    const h = harness({ '/work/app/AGENTS.md': 'personal' }, (fs) => ({
      ...fs,
      readFile: (path) =>
        path.endsWith('AGENTS.md') ? Promise.reject(new Error('brief denied')) : fs.readFile(path),
    }));
    expect(await h.run(['new', 'app', '--agents'])).toBe(1);
    expect(h.fs.has('/work/app/package.json')).toBe(true);
    expect(h.fs.read('/work/app/AGENTS.md')).toBe('personal');
  });
});
