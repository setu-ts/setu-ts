import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IFileSystem } from '@setu-ts/common';
import { createDenoRuntimeServices } from '@setu-ts/runtime';
import { runCli } from '../../src/cli.ts';
import { createRecorder } from '../fixtures/fake-fs.ts';

/** Snapshot includes empty directories, so rollback cannot leave hidden scaffold debris. */
async function snapshot(root: string): Promise<Record<string, number[] | null>> {
  const entries: Record<string, number[] | null> = {};
  async function visit(relative: string): Promise<void> {
    for await (const entry of Deno.readDir(`${root}/${relative}`)) {
      const path = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory) {
        entries[path] = null;
        await visit(path);
      } else {
        entries[path] = [...await Deno.readFile(`${root}/${path}`)];
      }
    }
  }
  await visit('');
  return entries;
}

async function fixture(work: (root: string, fs: IFileSystem) => Promise<void>): Promise<void> {
  await Deno.mkdir('.tmp', { recursive: true });
  const root = await Deno.makeTempDir({ dir: await Deno.realPath('.tmp'), prefix: 'm99b-' });
  try {
    await work(root, createDenoRuntimeServices().fs!);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

function cli(root: string, fs: IFileSystem) {
  const out = createRecorder();
  const err = createRecorder();
  return {
    out,
    err,
    run: (args: readonly string[]) =>
      runCli(args, {
        fs,
        cwd: root,
        now: () => 0,
        log: out.sink,
        error: err.sink,
        portAvailable: () => Promise.resolve(true),
      }),
  };
}

describe('interrupted scaffolding on the real filesystem', () => {
  it('restores the starting tree when a nested write is refused and retries successfully', async () => {
    await fixture(async (root, fs) => {
      await Deno.mkdir(`${root}/app/src`, { recursive: true });
      const before = await snapshot(root);
      let reject = true;
      const app = cli(root, {
        ...fs,
        writeFile(path, data) {
          if (reject && path.startsWith(`${root}/app/src/`)) {
            return Promise.reject(new Error('read-only src directory'));
          }
          return fs.writeFile(path, data);
        },
      });
      expect(await app.run(['new', 'app', '--template', 'rest'])).toBe(1);
      expect(app.err.text()).toContain('read-only src directory');
      expect(await snapshot(root)).toEqual(before);
      reject = false;
      expect(await app.run(['new', 'app', '--template', 'rest'])).toBe(0);
      expect(await Deno.readTextFile(`${root}/app/setu.config.ts`)).toContain('createApp');
    });
  });

  it('restores every workspace file when the last write of generate app partially fails', async () => {
    await fixture(async (root, fs) => {
      const setup = cli(root, fs);
      expect(await setup.run(['new', 'acme', '--workspace'])).toBe(0);
      const workspace = `${root}/acme`;
      const args = ['generate', 'app', 'third', '--template', 'microservice'];
      const ordinary = cli(workspace, fs);
      for (const name of ['first', 'second']) {
        expect(await ordinary.run(['generate', 'app', name, '--template', 'microservice'])).toBe(0);
      }
      const before = await snapshot(workspace);
      expect(Object.keys(before)).toContain('docker/compose.yaml');
      expect(Object.keys(before)).toContain('k8s/members.yaml');
      expect(Object.keys(before)).toContain('apps/first/src/discovery/services.ts');
      const dry = cli(workspace, fs);
      expect(await dry.run([...args, '--dry-run'])).toBe(0);
      const last = dry.out.lines.filter((line) => line.startsWith('would create ')).at(-1)!
        .slice('would create '.length);
      expect(last.length).toBeGreaterThan(workspace.length);
      let failed = false;
      const failing = cli(workspace, {
        ...fs,
        async writeFile(path, data) {
          if (path === last && !failed) {
            failed = true;
            await fs.writeFile(path, data.slice(0, 3));
            throw new Error('last write failed');
          }
          await fs.writeFile(path, data);
        },
      });
      expect(await failing.run(args)).toBe(1);
      expect(failed).toBe(true);
      expect(await snapshot(workspace)).toEqual(before);
      expect(await ordinary.run(args)).toBe(0);
      expect(await Deno.readTextFile(`${workspace}/apps/first/src/discovery/services.ts`))
        .toContain('third');
    });
  });

  it('removes generated module files when its existing aggregate barrel rejects', async () => {
    await fixture(async (root, fs) => {
      expect(await cli(root, fs).run(['new', 'app', '--template', 'class-based'])).toBe(0);
      const project = `${root}/app`;
      const before = await snapshot(project);
      const barrel = `${project}/src/modules/index.ts`;
      const failing = cli(project, {
        ...fs,
        writeFile: (path, data) =>
          path === barrel
            ? Promise.reject(new Error('read-only barrel'))
            : fs.writeFile(path, data),
      });
      expect(await failing.run(['generate', 'module', 'orders'])).toBe(1);
      expect(failing.err.text()).not.toContain('rollback incomplete');
      expect(await snapshot(project)).toEqual(before);
      expect(await cli(project, fs).run(['generate', 'module', 'orders'])).toBe(0);
      expect(await Deno.readTextFile(barrel)).toContain('Orders');
    });
  });
});
