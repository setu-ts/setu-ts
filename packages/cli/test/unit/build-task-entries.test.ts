import { describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import type { Plugin } from 'esbuild';
import { createFakeFs } from '../fixtures/fake-fs.ts';
import { discoverTasks, taskReferences, taskRewritePlugin } from '../../src/build/task-entries.ts';

function resolveFakeFiles(): Plugin {
  return {
    name: 'fake-files',
    setup(api) {
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
        plugins: [taskRewritePlugin(fs, '/app', `main.${extension}`), resolveFakeFiles()],
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
      plugins: [taskRewritePlugin(fs, '/app', 'src/tasks/first.task.ts'), resolveFakeFiles()],
    });
    expect(result.outputFiles[0]?.text).toContain('./second.task.js');
    await expect(
      build({
        absWorkingDir: '/app',
        entryPoints: ['missing.ts'],
        bundle: true,
        write: false,
        logLevel: 'silent',
        plugins: [taskRewritePlugin(fs, '/app', 'main.ts'), resolveFakeFiles()],
      }),
    ).rejects.toThrow('Cannot read file');
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
      plugins: [taskRewritePlugin(fs, '/app', 'main.ts'), resolveFakeFiles()],
    });
    expect(result.outputFiles[0]?.text).toContain('new URL("./src/tasks/b.task.js"');
  });
  it('does not rewrite URL-shaped text inside another string or an erased type import', () => {
    expect(() =>
      taskReferences('const label = "new URL(\'./x.task.ts\', import.meta.url)";', '/app/main.ts'),
    ).toThrow('worker task references must use');
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
    for (const source of ["'./hash.task.ts'", '`./${name}.task.ts`']) {
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
          taskRewritePlugin(fs, '/app', entry),
          {
            name: 'fake-resolve',
            setup(api) {
              api.onResolve({ filter: /.*/ }, ({ path, resolveDir }) => ({
                path: path.startsWith('/')
                  ? path
                  : `${resolveDir || '/app'}/${path}`
                      .split('/')
                      .reduce<string[]>((parts, part) => {
                        if (part === '..') parts.pop();
                        else if (part !== '.') parts.push(part);
                        return parts;
                      }, [])
                      .join('/'),
              }));
            },
          },
        ],
      });
      expect(result.outputFiles[0]?.text).toContain(expected);
    }
  });
});
