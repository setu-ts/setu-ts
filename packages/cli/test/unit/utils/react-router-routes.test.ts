import { describe, expect, it, vi } from 'vitest';
import { kernelShadows, pagePaths, readPagePaths } from '../../../src/utils/react-router-routes.ts';
import { createFakeFs } from '../../fixtures/fake-fs.ts';
import type { CommandRunner } from '../../../src/utils/run-command.ts';

describe('pagePaths', () => {
  it('joins nested paths through layouts and keeps index paths, params, optionals and splats', () => {
    expect(
      pagePaths([
        {
          id: 'root',
          path: '',
          children: [
            {
              id: 'layout',
              children: [
                { id: 'home', index: true },
                { id: 'products', index: true, path: 'products' },
                {
                  id: 'docs',
                  path: '/docs/',
                  children: [
                    { id: 'detail', path: ':id' },
                    { id: 'splat', path: '*' },
                  ],
                },
                { id: 'optional', path: ':lang?/help' },
              ],
            },
          ],
        },
      ]),
    ).toEqual(['/', '/products', '/docs', '/docs/:id', '/docs/*', '/:lang?/help']);
    expect(pagePaths([])).toEqual([]);
  });
  for (const tree of [
    null,
    {},
    [null],
    [{}],
    [{ id: 1 }],
    [{ id: 'x', path: 2 }],
    [{ id: 'x', file: 2 }],
    [{ id: 'x', index: 'true' }],
    [{ id: 'x', children: {} }],
  ]) {
    it(`rejects malformed route trees: ${JSON.stringify(tree)}`, () =>
      expect(() => pagePaths(tree)).toThrow());
  }
});

describe('kernelShadows', () => {
  for (const [base, page, expected] of [
    ['/products', '/products', true],
    ['/products', '/products/:id', true],
    ['/products', '/products/x', true],
    ['/products', '/products/x/y', false],
    ['/products', '/productsx', false],
    ['/products', '/*', false],
    ['/docs', '/docs/*', false],
    ['/api/products', '/products', false],
    ['products/', '/products/', true],
    ['/products', '/:section', false],
  ] as const) {
    it(`${base} vs ${page} = ${expected}`, () => expect(kernelShadows(base, page)).toBe(expected));
  }
});

const fs = createFakeFs({ '/app/node_modules/.bin/react-router': '' });

it('X87-1 finds the nearest workspace binary, never a standalone parent binary', async () => {
  for (const local of [false, true]) {
    const run = vi.fn(() => Promise.resolve({ code: 0, stdout: '[]', stderr: '' }));
    const workspace = createFakeFs({
      '/work/package.json': '{"workspaces":["apps/*"]}',
      '/work/node_modules/.bin/react-router': '',
      ...(local ? { '/work/apps/api/node_modules/.bin/react-router': '' } : {}),
    });
    expect((await readPagePaths('/work/apps/api', run, workspace)).ok).toBe(true);
    expect(run).toHaveBeenCalledWith(
      `${local ? '/work/apps/api' : '/work'}/node_modules/.bin/react-router`,
      ['routes', '--json'],
      { cwd: '/work/apps/api', signal: expect.any(AbortSignal) },
    );
  }
  for (const seed of [{ '/work/node_modules/.bin/react-router': '' }, {}]) {
    const run = vi.fn();
    const result = await readPagePaths('/work/app', run, createFakeFs(seed));
    expect(result).toEqual({ ok: false, reason: 'React Router binary is not installed' });
    expect(run).not.toHaveBeenCalled();
  }
});

describe('readPagePaths', () => {
  it('runs only the installed local executable and retains filenames for the refusal', async () => {
    const run: CommandRunner = vi.fn(() =>
      Promise.resolve({
        code: 0,
        stdout: JSON.stringify([{ id: 'x', path: 'products', file: './routes/products.tsx' }]),
        stderr: '',
      }),
    );
    const result = await readPagePaths('/app', run, fs);
    expect(run).toHaveBeenCalledWith('/app/node_modules/.bin/react-router', ['routes', '--json'], {
      cwd: '/app',
      signal: expect.any(AbortSignal),
    });
    expect(result).toEqual({
      ok: true,
      paths: ['/products'],
      files: new Map([['/products', 'app/routes/products.tsx']]),
    });
  });
  for (const [label, run] of [
    ['nonzero', () => Promise.resolve({ code: 127, stdout: '', stderr: 'missing executable' })],
    ['nonzero without stderr', () => Promise.resolve({ code: 1, stdout: '', stderr: '  \n' })],
    ['invalid JSON', () => Promise.resolve({ code: 0, stdout: '{', stderr: '' })],
    ['invalid tree', () => Promise.resolve({ code: 0, stdout: '{}', stderr: '' })],
    ['rejection', () => Promise.reject(new Error('broken runner'))],
    ['non-Error rejection', () => Promise.reject('broken')],
  ] as const) {
    it(`returns an advisory failure for ${label}`, async () =>
      expect((await readPagePaths('/app', run, fs)).ok).toBe(false));
  }
  it('names only the first stderr line, or says there was none', async () => {
    for (const [stderr, reason] of [
      ['\nboom\n    at frame 1\n', 'React Router exited 1: boom'],
      ['  \n', 'React Router exited 1: (no output)'],
    ] as const) {
      expect(
        await readPagePaths('/app', () => Promise.resolve({ code: 1, stdout: '', stderr }), fs),
      ).toEqual({ ok: false, reason });
    }
  });
  it('times out at 15 seconds and aborts the child', async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const result = readPagePaths(
        '/app',
        async (_command, _args, options) => {
          signal = options.signal;
          return await new Promise(() => {});
        },
        fs,
      );
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await result).toEqual({
        ok: false,
        reason: 'React Router route read timed out after 15 s',
      });
      expect(signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
