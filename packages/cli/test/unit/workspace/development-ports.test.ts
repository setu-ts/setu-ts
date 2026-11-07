import { expect, it } from 'vitest';
import {
  rewriteInspectorScript,
  planInspectorRewrite,
} from '../../../src/workspace/development-ports.ts';
import { createFakeFs } from '../../fixtures/fake-fs.ts';

it('L4 turns unreadable inspector manifests into a manual-edit note', async () => {
  const fs = createFakeFs({ '/app/package.json': '{}' });
  const notes: string[] = [];
  expect(
    await planInspectorRewrite(
      { ...fs, readFile: () => Promise.reject(new Error('permission denied')) },
      '/app',
      'node',
      5100,
      (line) => notes.push(line),
    ),
  ).toEqual([]);
  expect(notes.join('\n')).toContain('could not be read');
  expect(notes.join('\n')).toContain('--inspect=127.0.0.1:5100');
});

it('X87-6 rewrites exactly one token and preserves comments and other scripts', () => {
  const source =
    '{// keep\n"tasks":{"start:debug":"deno run --inspect main.ts","other":"--inspect"}}';
  expect(rewriteInspectorScript(source, 'tasks', 5000)).toBe(
    source.replace('deno run --inspect main.ts', 'deno run --inspect=127.0.0.1:5000 main.ts'),
  );
  expect(
    rewriteInspectorScript(
      '{"scripts":{"start:debug":"node --inspect=127.0.0.1:5000 main.ts"}}',
      'scripts',
      5100,
      5000,
    ),
  ).toContain('--inspect=127.0.0.1:5100');
  for (const source of [
    '{',
    '{}',
    '{"tasks":{"start:debug":3}}',
    '{"tasks":{"start:debug":"deno --inspect --inspect main.ts"}}',
    '{"tasks":{"start:debug":"deno --inspect-brk main.ts"}}',
  ])
    expect(rewriteInspectorScript(source, 'tasks', 5000)).toBeUndefined();
});

it('X87-6 plans Node, Bun, Deno JSONC and missing/edited manifest outcomes', async () => {
  for (const runtime of ['node', 'bun', 'deno'] as const) {
    const name = runtime === 'deno' ? 'deno.jsonc' : 'package.json';
    const section = runtime === 'deno' ? 'tasks' : 'scripts';
    const fs = createFakeFs({
      [`/app/${name}`]: JSON.stringify({
        [section]: { 'start:debug': `${runtime} --inspect main.ts` },
      }),
    });
    expect(
      (await planInspectorRewrite(fs, '/app', runtime, 5100, () => {}))[0]?.contents,
    ).toContain('--inspect=127.0.0.1:5100');
  }
  for (const seed of [{}, { '/app/package.json': '{}' }]) {
    const notes: string[] = [];
    expect(
      await planInspectorRewrite(createFakeFs(seed), '/app', 'node', 5100, (line) =>
        notes.push(line),
      ),
    ).toEqual([]);
    expect(notes[0]).toContain('--inspect=127.0.0.1:5100');
  }
});
