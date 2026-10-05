import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createFakeFs, createRecorder } from '../fixtures/fake-fs.ts';
import { parseArgs } from '../../src/args.ts';
import { runDevtoolCommand } from '../../src/commands/devtool.ts';
import { runWorkspaceCommand } from '../../src/commands/workspace.ts';
import { runNewCommand } from '../../src/commands/new.ts';
import { runAppCommand } from '../../src/commands/app.ts';
import { factoryRefusal, standaloneDevtoolPort } from '../../src/devtool/planner.ts';
import { devEntryVariants, renderDevEntry } from '../../src/devtool/dev-entry.ts';
import {
  allocateDevtoolPort,
  devtoolRangeStart,
  readWorkspaceManifest,
  renderWorkspaceManifest,
  type WorkspaceManifest,
} from '../../src/workspace/manifest.ts';
import { workspaceProfile } from '../../src/workspace/runtime-profile.ts';

const plugins = '...(devtool?.plugins ?? [])';
const diagnostics =
  '...(devtool?.diagnostics !== undefined ? { diagnostics: devtool.diagnostics } : {})';
const signature =
  'devtool?: { plugins?: readonly IPlugin[]; diagnostics?: KernelDiagnosticsOptions }';
const config =
  `export function createApp(${signature}) { return createApplication({ plugins: [${plugins}], ${diagnostics} }); }`;
const manifest: WorkspaceManifest = {
  version: 1,
  basePort: 5869,
  devtoolBasePort: 6000,
  runtime: 'deno',
  transport: 'http',
  members: [{ name: 'orders', port: 5869 }],
};
const seed = {
  '/ws/setu.workspace.json': renderWorkspaceManifest(manifest),
  '/ws/deno.json': JSON.stringify({
    workspace: ['./apps/*'],
    tasks: { dev: workspaceProfile('deno').runAll },
  }),
  '/ws/apps/orders/deno.json': JSON.stringify({ tasks: { start: 'deno run -A main.ts' } }),
  '/ws/apps/orders/setu.config.ts': config,
  '/ws/apps/orders/.setu-member': '',
};

describe('M101f lifecycle refusals and allocation', () => {
  it('retains a standalone entry port without probing again when availability changes', async () => {
    for (const port of [4919, 4920, 6200]) {
      for (const entry of devEntryVariants(port, false)) {
        const fs = createFakeFs();
        expect(
          await runNewCommand(parseArgs(['shop', '--devtool', '--devtool-port', String(port)]), {
            fs,
            cwd: '/ws',
            log: () => {},
            error: () => {},
          }),
        ).toBe(0);
        await fs.writeFile('/ws/shop/main.dev.ts', new TextEncoder().encode(entry));
        const before = fs.writes.length;
        const log = createRecorder();
        expect(
          await runDevtoolCommand(parseArgs(['enable']), {
            fs,
            cwd: '/ws/shop',
            log: log.sink,
            error: () => {},
            portAvailable: () => {
              throw new Error('an enabled project must not probe for a new port');
            },
          }),
        ).toBe(0);
        const current = renderDevEntry({ devtoolPort: port });
        // Either way the recorded port is kept and the file ends up current: an
        // unchanged current entry is left alone, a 0.8.0 entry is upgraded in place.
        expect(fs.read('/ws/shop/main.dev.ts')).toBe(current);
        if (entry === current) {
          expect(log.text()).toContain('already enabled');
          expect(fs.writes.length).toBe(before);
        } else {
          expect(log.text()).toContain('updated /ws/shop/main.dev.ts');
        }
      }
    }
  });

  it('upgrades a 0.8.0 member entry when the devtool is re-enabled', async () => {
    const fs = createFakeFs();
    const deps = { fs, log: () => {}, error: () => {} };
    expect(
      await runNewCommand(parseArgs(['ws', '--workspace', '--port', '3000']), {
        ...deps,
        cwd: '/',
      }),
    ).toBe(0);
    expect(
      await runAppCommand(parseArgs(['app', 'orders', '--devtool', '--devtool-port', '5123']), {
        ...deps,
        dir: '/ws',
      }),
    ).toBe(0);
    const legacy = await Deno.readTextFile(
      new URL('../fixtures/dev-entry-0.8.0-member.txt', import.meta.url),
    );
    await fs.writeFile('/ws/apps/orders/main.dev.ts', new TextEncoder().encode(legacy));
    const log = createRecorder();
    expect(
      await runDevtoolCommand(parseArgs(['enable', 'orders']), {
        fs,
        cwd: '/ws',
        log: log.sink,
        error: () => {},
      }),
    ).toBe(0);
    expect(fs.read('/ws/apps/orders/main.dev.ts')).toBe(
      renderDevEntry({
        devtoolPort: 5123,
        port: { symbol: 'SERVICE_PORT', from: './src/discovery/services.ts' },
      }),
    );
    expect(log.text()).toContain('updated /ws/apps/orders/main.dev.ts');
  });

  it('says a re-enabled workspace member needs nothing, instead of reporting it enabled', async () => {
    const fs = createFakeFs();
    const deps = { fs, log: () => {}, error: () => {} };
    expect(
      await runNewCommand(parseArgs(['ws', '--workspace', '--port', '3000']), {
        ...deps,
        cwd: '/',
      }),
    ).toBe(0);
    expect(await runAppCommand(parseArgs(['app', 'orders', '--devtool']), { ...deps, dir: '/ws' }))
      .toBe(0);
    const before = fs.writes.length;
    const log = createRecorder();
    expect(
      await runDevtoolCommand(parseArgs(['enable', 'orders']), {
        fs,
        cwd: '/ws',
        log: log.sink,
        error: () => {},
      }),
    ).toBe(0);
    expect(log.text()).toBe('The devtool is already enabled for orders; nothing to change.');
    expect(fs.writes.length).toBe(before);
  });
  it('requires the signature and both usage fragments and prints their locations', () => {
    const legacy = factoryRefusal('export function createApp(): IApplication {');
    expect(legacy).toContain(signature);
    expect(legacy).toContain(plugins);
    expect(legacy).toContain(diagnostics);
    expect(factoryRefusal(signature)).toContain('Missing usage fragments');
    expect(factoryRefusal(signature + plugins)).toContain(
      `Missing usage fragments: ${diagnostics}`,
    );
    expect(factoryRefusal(config)).toBeUndefined();
    expect(factoryRefusal('handwritten factory')).toBeUndefined();
  });

  it('allocates from the connector range, skips configured app ports and exhausts at MAX_PORT', () => {
    expect(allocateDevtoolPort(manifest)).toBe(6000);
    expect(allocateDevtoolPort({ ...manifest, members: [{ name: 'a', port: 6000 }] })).toBe(6001);
    expect(
      allocateDevtoolPort({ ...manifest, members: [{ name: 'a', port: 1, devtoolPort: 6005 }] }),
    ).toBe(6006);
    expect(
      devtoolRangeStart(
        { ...manifest, devtoolBasePort: undefined } as unknown as WorkspaceManifest,
      ),
    ).toBe(6869);
    expect(
      devtoolRangeStart(
        {
          ...manifest,
          basePort: 65530,
          devtoolBasePort: undefined,
        } as unknown as WorkspaceManifest,
      ),
    ).toBe(65535);
    expect(
      allocateDevtoolPort({
        ...manifest,
        devtoolBasePort: 65535,
        members: [{ name: 'a', port: 65535 }],
      }),
    ).toBeUndefined();
  });

  it('validates the recorded connector range shape and range', async () => {
    for (const value of ['6000', null, 0, 65536, 1.2]) {
      const fs = createFakeFs({
        '/ws/setu.workspace.json': JSON.stringify({ ...manifest, devtoolBasePort: value }),
      });
      expect((await readWorkspaceManifest(fs, '/ws')).ok).toBe(false);
    }
    const fs = createFakeFs(seed);
    const read = await readWorkspaceManifest(fs, '/ws');
    expect(read.ok && read.manifest.devtoolBasePort).toBe(6000);
  });

  it('refuses every mismatched framework pin in normal and dry-run modes with zero writes', async () => {
    for (const dry of [[], ['--dry-run']]) {
      const fs = createFakeFs({
        ...seed,
        '/ws/apps/orders/deno.json': JSON.stringify({
          tasks: { start: 'deno run -A main.ts' },
          imports: Object.fromEntries(
            ['common', 'kernel', 'runtime'].map((
              name,
            ) => [`@setu-ts/${name}`, `jsr:@setu-ts/${name}@^0.7.0`]),
          ),
        }),
      });
      const error = createRecorder();
      expect(
        await runDevtoolCommand(parseArgs(['enable', 'orders', ...dry]), {
          fs,
          cwd: '/ws',
          log: () => {},
          error: error.sink,
        }),
      ).toBe(1);
      for (const name of ['common', 'kernel', 'runtime']) {
        expect(error.text()).toContain(`@setu-ts/${name}`);
      }
      expect(error.text()).toContain('upgrade the project first');
      expect(fs.writes).toEqual([]);
    }
  });

  it('names Node, Bun and Workers before looking for a Deno project', async () => {
    for (
      const [runtime, files] of [
        ['node', { '/ws/package.json': '{"scripts":{"start":"node main.ts"}}' }],
        ['bun', { '/ws/package.json': '{"scripts":{"start":"bun main.ts"}}' }],
        ['cloudflare-workers', {
          '/ws/wrangler.jsonc': '{}',
          '/ws/deno.json': '{"tasks":{"start":"deno serve main.ts"}}',
        }],
      ] as const
    ) {
      const fs = createFakeFs(files);
      const error = createRecorder();
      expect(
        await runDevtoolCommand(parseArgs(['enable']), {
          fs,
          cwd: '/ws',
          log: () => {},
          error: error.sink,
        }),
      ).toBe(1);
      expect(error.text()).toContain(`a ${runtime} project`);
      expect(fs.writes).toEqual([]);
    }
  });

  it('probes the standalone default and records it in the entry and README', async () => {
    const fs = createFakeFs();
    expect(
      await runNewCommand(parseArgs(['shop', '--devtool']), {
        fs,
        cwd: '/ws',
        log: () => {},
        error: () => {},
        portAvailable: (port) => Promise.resolve(port === 4921),
      }),
    ).toBe(0);
    expect(fs.read('/ws/shop/main.dev.ts')).toContain('port: 4921,');
    expect(fs.read('/ws/shop/README.md')).toContain('127.0.0.1:4921');
    const probed: number[] = [];
    expect(
      await standaloneDevtoolPort((port) => {
        probed.push(port);
        return Promise.resolve(false);
      }),
    ).toBeUndefined();
    expect(probed.at(-1)).toBe(5019);
  });

  it('enables in the connector range and regenerates production exclusions', async () => {
    const fs = createFakeFs(seed);
    expect(
      await runDevtoolCommand(parseArgs(['enable', 'orders']), {
        fs,
        cwd: '/ws',
        log: () => {},
        error: () => {},
      }),
    ).toBe(0);
    expect(fs.read('/ws/apps/orders/main.dev.ts')).toContain('port: 6000,');
    expect(fs.read('/ws/.dockerignore')).toContain('apps/*/main.dev.ts');
    expect(fs.read('/ws/docker/Dockerfile')).toContain(
      'deno install --entrypoint main.ts --frozen',
    );
  });

  it('reallocates the current and the 0.8.0 CLI entry and reports updated', async () => {
    for (const entry of devEntryVariants(4919)) {
      const fs = createFakeFs({
        ...seed,
        '/ws/setu.workspace.json': renderWorkspaceManifest({
          ...manifest,
          members: [{ name: 'orders', port: 5869, devtoolPort: 4919 }],
        }),
        '/ws/apps/orders/main.dev.ts': entry,
      });
      const log = createRecorder();
      expect(
        await runWorkspaceCommand(parseArgs(['ports', '--reallocate']), {
          fs,
          cwd: '/ws',
          log: log.sink,
          error: () => {},
        }),
      ).toBe(0);
      expect(fs.read('/ws/apps/orders/main.dev.ts')).toContain('port: 6000,');
      expect(log.text()).toContain('updated /ws/apps/orders/main.dev.ts');
    }
  });

  it('upgrades an entry the 0.8.0 CLI rendered instead of calling it edited', async () => {
    // The devtool first shipped in 0.8.0, so its rendering — which predates the
    // composition probe — is what every existing member carries. The fixtures
    // are that release's renderer output, captured byte for byte.
    const fixture = (name: string) =>
      Deno.readTextFileSync(new URL(`../fixtures/dev-entry-0.8.0-${name}.txt`, import.meta.url));
    expect(devEntryVariants(5123)).toContain(fixture('member'));
    expect(devEntryVariants(4919, false)).toContain(fixture('standalone'));

    const fs = createFakeFs({
      ...seed,
      '/ws/setu.workspace.json': renderWorkspaceManifest({
        ...manifest,
        members: [{ name: 'orders', port: 5869, devtoolPort: 5123 }],
      }),
      '/ws/apps/orders/main.dev.ts': fixture('member'),
    });
    const log = createRecorder();
    expect(
      await runWorkspaceCommand(parseArgs(['ports', '--reallocate']), {
        fs,
        cwd: '/ws',
        log: log.sink,
        error: () => {},
      }),
    ).toBe(0);
    expect(fs.read('/ws/apps/orders/main.dev.ts')).toBe(
      renderDevEntry({
        devtoolPort: 6000,
        port: { symbol: 'SERVICE_PORT', from: './src/discovery/services.ts' },
      }),
    );
    expect(log.text()).toContain('updated /ws/apps/orders/main.dev.ts');
  });

  it('keeps application ports in their own sequence across devtool members', async () => {
    // F1: `generate app` after a devtool member used to land at basePort + 1001,
    // inside the connector range, because allocatePort walked devtool ports.
    const fs = createFakeFs();
    const deps = { fs, log: () => {}, error: () => {} };
    expect(
      await runNewCommand(parseArgs(['ws', '--workspace', '--port', '3000']), {
        ...deps,
        cwd: '/',
      }),
    ).toBe(0);
    for (
      const argv of [['app', 'alpha', '--devtool'], ['app', 'beta'], ['app', 'gamma', '--devtool']]
    ) {
      expect(await runAppCommand(parseArgs(argv), { ...deps, dir: '/ws' })).toBe(0);
    }
    const members = (JSON.parse(fs.read('/ws/setu.workspace.json')) as WorkspaceManifest).members
      .map((member) => [member.name, member.port, member.devtoolPort]);
    expect(members).toEqual([
      ['alpha', 3000, 4000],
      ['beta', 3001, undefined],
      ['gamma', 3002, 4001],
    ]);
  });

  it('refuses edited and missing entries before any write', async () => {
    for (const source of ['edited', undefined]) {
      const fs = createFakeFs({
        ...seed,
        '/ws/setu.workspace.json': renderWorkspaceManifest({
          ...manifest,
          members: [{ name: 'orders', port: 5869, devtoolPort: 4919 }],
        }),
        ...(source === undefined ? {} : { '/ws/apps/orders/main.dev.ts': source }),
      });
      const error = createRecorder();
      expect(
        await runWorkspaceCommand(parseArgs(['ports', '--reallocate']), {
          fs,
          cwd: '/ws',
          log: () => {},
          error: error.sink,
        }),
      ).toBe(1);
      expect(error.text()).toContain(
        source === undefined ? 'this entry is missing' : 'launcher accepts only',
      );
      expect(error.text().split('\n')).toHaveLength(1);
      expect(fs.writes).toEqual([]);
    }
  });
});
