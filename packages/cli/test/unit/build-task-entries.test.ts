import { describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import type { Plugin } from 'esbuild';
import { createFakeFs } from '../fixtures/fake-fs.ts';
import { discoverTasks, taskReferences, taskRewritePlugin } from '../../src/build/task-entries.ts';

/** Resolves and loads from the fake fs, standing in for esbuild's own disk reads. */
function resolveFakeFiles(fs: ReturnType<typeof createFakeFs>): Plugin {
  return {
    name: 'fake-files',
    setup(api) {
      api.onLoad({ filter: /.*/ }, async ({ path }) => ({
        contents: new TextDecoder().decode(await fs.readFile(path)),
        loader: /\.tsx$/.test(path)
          ? 'tsx'
          : /\.jsx$/.test(path)
            ? 'jsx'
            : /\.ts$/.test(path)
              ? 'ts'
              : 'js',
      }));
      api.onResolve({ filter: /.*/ }, ({ path, resolveDir }) => {
        const file = path.endsWith('.task') ? `${path}.ts` : path;
        return {
          path: file.startsWith('/')
            ? file
            : `${resolveDir || '/app'}/${file}`
                .split('/')
                .reduce<string[]>((parts, part) => {
                  if (part === '..') parts.pop();
                  else if (part !== '.') parts.push(part);
                  return parts;
                }, [])
                .join('/'),
        };
      });
    },
  };
}

describe('worker task entries', () => {
  it('loads TSX, JSX and JavaScript and relocates nested task entry URLs', async () => {
    for (const extension of ['tsx', 'jsx', 'js']) {
      const fs = createFakeFs({
        [`/app/main.${extension}`]:
          extension === 'js' ? 'console.log(1);' : 'console.log(<div />);',
      });
      const result = await build({
        absWorkingDir: '/app',
        entryPoints: [`main.${extension}`],
        bundle: true,
        write: false,
        plugins: [taskRewritePlugin(fs, '/app', `main.${extension}`), resolveFakeFiles(fs)],
      });
      expect(result.outputFiles[0]?.text).toContain(
        extension === 'js' ? 'console.log(1)' : 'createElement',
      );
    }
    const fs = createFakeFs({
      '/app/src/tasks/first.task.ts': "console.log(new URL('./second.task.ts', import.meta.url));",
      '/app/src/tasks/second.task.ts': '',
    });
    const result = await build({
      absWorkingDir: '/app',
      entryPoints: ['src/tasks/first.task.ts'],
      bundle: true,
      format: 'esm',
      write: false,
      plugins: [
        taskRewritePlugin(fs, '/app', 'src/tasks/first.task.ts', ['src/tasks/second.task.ts']),
        resolveFakeFiles(fs),
      ],
    });
    expect(result.outputFiles[0]?.text).toContain('./second.task.js');
    await expect(
      build({
        absWorkingDir: '/app',
        entryPoints: ['missing.ts'],
        bundle: true,
        write: false,
        logLevel: 'silent',
        plugins: [taskRewritePlugin(fs, '/app', 'main.ts'), resolveFakeFiles(fs)],
      }),
    ).rejects.toThrow();
  });
  it('relocates literals in imported task source relative to the containing application output', async () => {
    const fs = createFakeFs({
      '/app/main.ts': "import './src/tasks/a.task';",
      '/app/src/tasks/a.task.ts': "console.log(new URL('./b.task.ts', import.meta.url));",
      '/app/src/tasks/b.task.ts': '',
    });
    const result = await build({
      absWorkingDir: '/app',
      entryPoints: ['main.ts'],
      bundle: true,
      format: 'esm',
      write: false,
      plugins: [
        taskRewritePlugin(fs, '/app', 'main.ts', ['src/tasks/b.task.ts']),
        resolveFakeFiles(fs),
      ],
    });
    expect(result.outputFiles[0]?.text).toContain('new URL("./src/tasks/b.task.js"');
  });
  it('does not rewrite URL-shaped text inside another string or an erased type import', () => {
    expect(
      taskReferences('const label = "new URL(\'./x.task.ts\', import.meta.url)";', '/app/main.ts'),
    ).toEqual([]);
    expect(taskReferences("export type { Input } from './x.task.ts';", '/app/main.ts')).toEqual([]);
  });
  it('finds extensionless TSX and index imports and rejects an escaping task target', async () => {
    const fs = createFakeFs({
      '/app/main.ts': "import './view'; import './routes'; import './missing';",
      '/app/view.tsx': "console.log(new URL('./view.task.ts', import.meta.url));",
      '/app/routes/index.ts': "console.log(new URL('../route.task.ts', import.meta.url));",
      '/app/view.task.ts': '',
      '/app/route.task.ts': '',
    });
    expect(await discoverTasks(fs, '/app', ['main.ts'])).toEqual(['route.task.ts', 'view.task.ts']);
    await fs.writeFile(
      '/app/main.ts',
      new TextEncoder().encode("new URL('../outside.task.ts', import.meta.url);"),
    );
    await expect(discoverTasks(fs, '/app', ['main.ts'])).rejects.toThrow();
  });
  it('locates literals, skips comments, and refuses other forms at their line', () => {
    expect(taskReferences('// ignored.task.ts\n/* ignored.task.ts */', '/app/main.ts')).toEqual([]);
    expect(
      taskReferences("new URL('./hash.task.ts', import.meta.url)", '/app/main.ts')[0]?.target,
    ).toBe('/app/hash.task.ts');
    for (const source of [
      'new URL(`./${name}.task.ts`, import.meta.url)',
      "new URL(base + 'hash.task.ts', import.meta.url)",
    ]) {
      expect(() => taskReferences(`\n${source}`, 'main.ts')).toThrow('main.ts:2:');
    }
  });
  it('scans cycles, extensionless imports and missing files once', async () => {
    const fs = createFakeFs({
      '/app/main.ts': "import './a'; import './missing.ts'; import 'external';",
      '/app/a.ts': "import './main.ts'; new URL('./hash.task.ts', import.meta.url);",
      '/app/hash.task.ts': '',
    });
    expect(await discoverTasks(fs, '/app', ['main.ts'])).toEqual(['hash.task.ts']);
  });
  it('rewrites the same config for main and the migration runner using the real bundler', async () => {
    const fs = createFakeFs({
      '/app/main.ts': "import './setu.config.ts';",
      '/app/src/migrations/run.ts': "import '../../setu.config.ts';",
      '/app/setu.config.ts': "console.log(new URL('./src/tasks/hash.task.ts', import.meta.url));",
      '/app/src/tasks/hash.task.ts': "console.log('task');",
    });
    for (const [entry, expected] of [
      ['main.ts', './src/tasks/hash.task.js'],
      ['src/migrations/run.ts', '../tasks/hash.task.js'],
    ] as const) {
      const result = await build({
        absWorkingDir: '/app',
        entryPoints: [entry],
        bundle: true,
        write: false,
        format: 'esm',
        platform: 'node',
        plugins: [
          taskRewritePlugin(fs, '/app', entry, ['src/tasks/hash.task.ts']),
          resolveFakeFiles(fs),
        ],
      });
      expect(result.outputFiles[0]?.text).toContain(expected);
    }
  });

  it('M5 refuses a task literal the build did not discover, and one outside the project', async () => {
    const fs = createFakeFs({
      '/app/main.ts': "import './src/pool.js';",
      '/app/src/pool.js': "export const pool = new URL('./tasks/hash.task.ts', import.meta.url);",
      '/app/src/tasks/hash.task.ts': '',
    });
    const bundle = (tasks: readonly string[], entry = 'main.ts') =>
      build({
        absWorkingDir: '/app',
        entryPoints: [entry],
        bundle: true,
        write: false,
        logLevel: 'silent',
        plugins: [taskRewritePlugin(fs, '/app', entry, tasks), resolveFakeFiles(fs)],
      });
    await expect(bundle([])).rejects.toThrow(
      '/app/src/pool.js:1: worker task target was not built: /app/src/tasks/hash.task.ts.',
    );
    await expect(bundle(['src/tasks/hash.task.ts'])).resolves.toBeDefined();
    await fs.writeFile(
      '/app/main.ts',
      new TextEncoder().encode("console.log(new URL('../outside.task.ts', import.meta.url));"),
    );
    await expect(bundle(['src/tasks/hash.task.ts'])).rejects.toThrow(
      'worker task target is outside the project',
    );
    await expect(bundle(['src/tasks/hash.task.ts'])).rejects.toThrow(
      "setu build bundles only this project's own task files",
    );
  });
  it('M6 scans an imported source larger than 1 MiB, and leaves dependencies to esbuild', async () => {
    const large = `export const data = '${'x'.repeat(1_200_000)}';`;
    const fs = createFakeFs({
      '/app/main.ts': "import './build/server/index.js';",
      '/app/build/server/index.js': large,
    });
    expect(await discoverTasks(fs, '/app', ['main.ts'])).toEqual([]);
    let loaded = 0;
    const plugin = taskRewritePlugin(fs, '/app', 'main.ts');
    plugin.setup({
      onLoad: (_options: unknown, callback: (args: { path: string }) => Promise<unknown>) => {
        void callback({ path: '/app/node_modules/dep/index.js' }).then((value) => {
          if (value === undefined) loaded++;
        });
        void callback({ path: '/app/build/server/index.js' }).then((value) => {
          if (value === undefined) loaded++;
        });
      },
    } as unknown as Parameters<Plugin['setup']>[0]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(loaded).toBe(2);
  });
  it('L2 skips quotes in regex literals and comment markers in template literals', () => {
    expect(
      taskReferences(
        "const re = /['\"]/; const u = new URL('./a.task.ts', import.meta.url);",
        '/app/main.ts',
      ).map((ref) => ref.target),
    ).toEqual(['/app/a.task.ts']);
    expect(
      taskReferences(
        "const t = `a/*`; const u = new URL('./a.task.ts', import.meta.url); const z = '*/';",
        '/app/main.ts',
      ).map((ref) => ref.target),
    ).toEqual(['/app/a.task.ts']);
    expect(taskReferences("console.log('built ./a.task.ts');", '/app/main.ts')).toEqual([]);
    expect(() => taskReferences("import x from './a.task.ts';", '/app/main.ts')).toThrow(
      'worker task references must use',
    );
  });
  it('scans a large file without semicolons in linear time (M139d audit F3)', () => {
    const source = Array.from(
      { length: 40_000 },
      (_, i) => `export type T${i} = { a: string }`,
    ).join('\n');
    const started = performance.now();
    expect(taskReferences(source, '/app/main.ts')).toEqual([]);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
  it('follows a .js import to its .ts sibling, as esbuild does (review finding 1)', async () => {
    const fs = createFakeFs({
      '/app/main.ts': "import { T } from './setu.config.js';",
      '/app/setu.config.ts': "import { T } from './src/tasks/index.js'; export { T };",
      '/app/src/tasks/index.ts':
        "export const T = new URL('./a.task.ts', import.meta.url); import './view.jsx'; import './m.mjs';",
      '/app/src/tasks/view.tsx': "new URL('./b.task.ts', import.meta.url);",
      '/app/src/tasks/m.mts': "new URL('./c.task.ts', import.meta.url);",
      '/app/src/tasks/a.task.ts': '',
      '/app/src/tasks/b.task.ts': '',
      '/app/src/tasks/c.task.ts': '',
    });
    expect(await discoverTasks(fs, '/app', ['main.ts'])).toEqual([
      'src/tasks/a.task.ts',
      'src/tasks/b.task.ts',
      'src/tasks/c.task.ts',
    ]);
  });
  it('accepts a Prettier-wrapped literal and an identifier starting with import (review finding 2)', () => {
    const wrapped =
      "const url = new URL(\n  './tasks/resize-image-for-thumbnails.task.ts',\n  import.meta.url,\n);";
    expect(taskReferences(wrapped, '/app/main.ts').map((ref) => ref.target)).toEqual([
      '/app/tasks/resize-image-for-thumbnails.task.ts',
    ]);
    expect(
      taskReferences(
        "importer.run(new URL('./a.task.ts', import.meta.url).href);",
        '/app/main.ts',
      ).map((ref) => ref.target),
    ).toEqual(['/app/a.task.ts']);
    for (const refused of [
      "const m = await import('./a.task.ts');",
      "import x from './a.task.ts';",
      "const href = import.meta.resolve('./a.task.ts');",
      "pool.run(import.meta.resolve('./a.task.ts'), x);",
      "export * from './a.task.ts';",
      "export { run } from './a.task.ts';",
      "import {\n  run,\n} from './a.task.ts';",
      "const href = import.meta.resolve(\n  './a.task.ts',\n);",
      "pool.run(\n  import.meta.resolve(\n    './a.task.ts',\n  ),\n);",
    ])
      expect(() => taskReferences(refused, '/app/main.ts'), refused).toThrow(
        'worker task references must use',
      );
  });
  it("follows esbuild's candidate order when two siblings exist (review round 2)", async () => {
    const fs = createFakeFs({
      '/app/main.ts': "import './v.jsx'; import './ext';",
      '/app/v.ts': "new URL('./a.task.ts', import.meta.url);",
      '/app/v.tsx': "new URL('./wrong.task.ts', import.meta.url);",
      '/app/ext.tsx': "new URL('./b.task.ts', import.meta.url);",
      '/app/ext.ts': "new URL('./wrong.task.ts', import.meta.url);",
      '/app/a.task.ts': '',
      '/app/b.task.ts': '',
      '/app/wrong.task.ts': '',
    });
    // Measured against esbuild 0.28: `./v.jsx` loads v.ts, `./ext` loads ext.tsx.
    expect(await discoverTasks(fs, '/app', ['main.ts'])).toEqual(['a.task.ts', 'b.task.ts']);
  });
  it('accepts a task literal after another import.meta property on the line (review round 3)', () => {
    for (const source of [
      "pool.run(import.meta.dirname, new URL('./a.task.ts', import.meta.url));",
      "createPool(import.meta.env, new URL('./a.task.ts', import.meta.url));",
    ])
      expect(
        taskReferences(source, '/app/main.ts').map((ref) => ref.target),
        source,
      ).toEqual(['/app/a.task.ts']);
  });
  it('finds a task URL inside a template substitution as code, not template text (CodeRabbit #582)', () => {
    // A substitution is code, so its literal is an ordinary reference: built and rewritten.
    for (const source of [
      "const href = `${new URL('./hash.task.ts', import.meta.url).href}`;",
      "const href = `${({ ready: true }) && new URL('./hash.task.ts', import.meta.url).href}`;",
      "const href = `${'}' + new URL('./hash.task.ts', import.meta.url).href}`;",
      "const href = `a ${`b ${new URL('./hash.task.ts', import.meta.url)}`} c`;",
    ])
      expect(
        taskReferences(source, '/app/main.ts').map((ref) => ref.target),
        source,
      ).toEqual(['/app/hash.task.ts']);
    for (const source of [
      'const msg = `${count} wrote ./hash.task.ts`;',
      "const message = `Task: ${name.replace('.task.ts', '')}`;",
      "const message = `Task: ${new URL('/status', import.meta.url).pathname + name.replace('.task.ts', '')}`;",
    ])
      expect(taskReferences(source, '/app/main.ts'), source).toEqual([]);
  });
  it('rewrites a task URL inside a template substitution in the bundle', async () => {
    const fs = createFakeFs({
      '/app/main.ts': "console.log(`${new URL('./src/a.task.ts', import.meta.url).href}`);",
      '/app/src/a.task.ts': '',
    });
    const result = await build({
      absWorkingDir: '/app',
      entryPoints: ['main.ts'],
      bundle: true,
      format: 'esm',
      write: false,
      plugins: [taskRewritePlugin(fs, '/app', 'main.ts', ['src/a.task.ts']), resolveFakeFiles(fs)],
    });
    expect(result.outputFiles[0]?.text).toContain('new URL("./src/a.task.js"');
  });
  it('follows require() in a substitution, and past a quote inside a regex (CodeRabbit #582)', async () => {
    const fs = createFakeFs({
      '/app/main.ts':
        "const re = /['\"]/; require('./worker.js');\nconst label = `${require('./other.js')}`;",
      '/app/worker.ts': "new URL('./a.task.ts', import.meta.url);",
      '/app/other.ts': "new URL('./b.task.ts', import.meta.url);",
      '/app/a.task.ts': '',
      '/app/b.task.ts': '',
    });
    expect(await discoverTasks(fs, '/app', ['main.ts'])).toEqual(['a.task.ts', 'b.task.ts']);
  });
  it('follows a literal require() of a local module (CodeRabbit #582)', async () => {
    const fs = createFakeFs({
      '/app/main.ts': "const worker = require('./worker.js');",
      '/app/worker.ts': "new URL('./a.task.ts', import.meta.url);",
      '/app/a.task.ts': '',
    });
    expect(await discoverTasks(fs, '/app', ['main.ts'])).toEqual(['a.task.ts']);
  });
  it('accepts a substitution that only formats a task-looking string (CodeRabbit #582)', () => {
    expect(
      taskReferences("const message = `Task: ${name.replace('.task.ts', '')}`;", '/app/main.ts'),
    ).toEqual([]);
  });
  it('does not follow an import or require in a comment or a string (CodeRabbit #582)', async () => {
    const fs = createFakeFs({
      '/app/main.ts':
        "// require('./legacy.js')\n/* import './old'; */\nconst s = \"require('./quoted.js')\";",
      '/app/legacy.ts': "import './stale.task.ts';",
      '/app/old.ts': "import './stale.task.ts';",
      '/app/quoted.ts': "import './stale.task.ts';",
    });
    // Following any of them would refuse the static task import inside.
    expect(await discoverTasks(fs, '/app', ['main.ts'])).toEqual([]);
  });
  it('counts a } or ) inside a string, and a nested call, correctly (CodeRabbit #582)', () => {
    for (const source of [
      "const url = new URL(getBase() + './hash.task.ts', import.meta.url);",
      "const url = new URL(join(')', './hash.task.ts'), import.meta.url);",
      "const href = import.meta.resolve(prefix() + './hash.task.ts');",
    ])
      expect(() => taskReferences(source, '/app/main.ts'), source).toThrow(
        'worker task references must use',
      );
    // A balanced literal after a nested call elsewhere on the line still counts.
    expect(
      taskReferences(
        "pool.run(f(g()), new URL('./a.task.ts', import.meta.url).href);",
        '/app/main.ts',
      ).map((ref) => ref.target),
    ).toEqual(['/app/a.task.ts']);
  });
  it('pairs delimiters in linear time on unclosed input (CodeRabbit #582 follow-up)', () => {
    // Growth, not a wall-clock bound: CI's coverage instrumentation runs this
    // scan about 8x slower, so an absolute limit fails a linear scan there.
    // Quadrupling the input quadruples a linear scan (measured 2.6x) and
    // multiplies a quadratic one by 16 (measured 12.9x for the per-span re-scan).
    const best = (source: string): number => {
      let fastest = Infinity;
      for (let run = 0; run < 3; run++) {
        const started = performance.now();
        taskReferences(source, '/app/main.ts');
        fastest = Math.min(fastest, performance.now() - started);
      }
      return fastest;
    };
    for (const unit of ['new URL(', '${']) {
      const wrap = (text: string): string => (unit === '${' ? `\`${text}\`` : text);
      best(wrap(unit.repeat(10_000))); // warm up
      const small = best(wrap(unit.repeat(100_000)));
      const large = best(wrap(unit.repeat(400_000)));
      expect(large / small, unit).toBeLessThan(8);
    }
  });
  it('reads the edges of the code view: unterminated input, regex classes and flags, division', () => {
    for (const source of [
      'const t = `never closed',
      'const t = `${a',
      '/* never closed',
      "const s = 'never closed\nnew URL('./a.task.ts', import.meta.url);",
      'const re = /[/]x/giu; const d = a / b / c; const e = (x) / 2; const f = [1] / 2;',
      'if (a) { b(); }\n/regex/.test(c);',
      'return /x/;',
      'const s = "escaped \\" quote"; const t = `esc \\` tick`;',
    ])
      expect(() => taskReferences(source, '/app/main.ts'), source).not.toThrow();
    // A literal after a regex holding a slash in a class is still found.
    expect(
      taskReferences(
        "const re = /[/]/; new URL('./a.task.ts', import.meta.url);",
        '/app/main.ts',
      ).map((ref) => ref.target),
    ).toEqual(['/app/a.task.ts']);
    // A string broken by a newline ends there; the next line is code again.
    expect(
      taskReferences(
        "const s = 'broken\nnew URL('./a.task.ts', import.meta.url);",
        '/app/main.ts',
      ).map((ref) => ref.target),
    ).toEqual(['/app/a.task.ts']);
  });
  it('ignores a task path in a comment inside a URL call, not one in template text (CodeRabbit #582)', () => {
    expect(
      taskReferences(
        "new URL('/status' /* unlike './hash.task.ts' */, import.meta.url);",
        '/app/main.ts',
      ),
    ).toEqual([]);
    expect(() =>
      taskReferences('new URL(`./${name}.task.ts`, import.meta.url);', '/app/main.ts'),
    ).toThrow('worker task references must use');
  });
});
