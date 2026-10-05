import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { parseArgs } from '../../src/args.ts';
import { runWorkspaceCommand } from '../../src/commands/workspace.ts';
import { runCli } from '../../src/cli.ts';
import { devEntryVariants } from '../../src/devtool/dev-entry.ts';
import { createFakeFs, createRecorder } from '../fixtures/fake-fs.ts';
import {
  renderWorkspaceManifest,
  WORKSPACE_MANIFEST,
  WORKSPACE_VERSION,
} from '../../src/workspace/manifest.ts';
import { reconcileMembers } from '../../src/workspace/reconcile.ts';

describe('runWorkspaceCommand', () => {
  it('escapes edited-entry refusal paths and reallocates restored entries on the same path', async () => {
    for (const control of ['\n', '\r', '\0', '\t', '\u001b', '\u2028', '\u2029', '\u202e']) {
      const cwd = `/ws${control}FORGED-PATH`;
      const entryPath = `${cwd}/apps/orders/main.dev.ts`;
      const ownedEntry = devEntryVariants(6000)[0]!;
      const fs = createFakeFs({
        [`${cwd}/${WORKSPACE_MANIFEST}`]: renderWorkspaceManifest({
          version: WORKSPACE_VERSION,
          runtime: 'deno',
          basePort: 3000,
          devtoolBasePort: 6000,
          transport: 'http',
          members: [{ name: 'orders', port: 3000, devtoolPort: 6000 }],
        }),
        [`${cwd}/apps/orders/.setu-member`]: '',
        [entryPath]: `${ownedEntry}\n// developer edit\n`,
      });
      const err = createRecorder();
      const deps = {
        fs,
        cwd,
        now: () => 0,
        log: createRecorder().sink,
        error: err.sink,
        portAvailable: (port: number) => Promise.resolve(port !== 6000),
      };
      expect(await runCli(['workspace', 'ports', '--reallocate'], deps)).toBe(1);
      expect(err.text().split('\n')).toHaveLength(1);
      const escaped = `\\u${control.charCodeAt(0).toString(16).padStart(4, '0')}`;
      expect(err.text()).toBe(
        `/ws${escaped}FORGED-PATH/apps/orders/main.dev.ts: the devtool launcher accepts only the CLI's rendering of this file, so an edited entry cannot be launched; restore it (delete it and run setu devtool enable orders) or move the port literal yourself.`,
      );
      expect(fs.writes).toEqual([]);
      await fs.writeFile(entryPath, new TextEncoder().encode(ownedEntry));
      expect(await runCli(['workspace', 'ports', '--reallocate'], deps)).toBe(0);
      expect(fs.read(entryPath)).toContain('port: 6001, // IPv4 loopback only');
      expect(fs.read(`${cwd}/${WORKSPACE_MANIFEST}`)).toContain('"devtoolPort": 6001');
    }
  });

  it('reallocates every member to a bindable port and refreshes discovery maps', async () => {
    const fs = createFakeFs({
      [`/ws/${WORKSPACE_MANIFEST}`]: renderWorkspaceManifest({
        version: WORKSPACE_VERSION,
        runtime: 'deno',
        basePort: 3000,
        transport: 'http',
        members: [{ name: 'orders', port: 3000 }, { name: 'billing', port: 3001 }],
      }),
      '/ws/apps/orders/.setu-member': '',
      '/ws/apps/billing/.setu-member': '',
    });
    const out = createRecorder();
    const err = createRecorder();

    const code = await runWorkspaceCommand(parseArgs(['ports', '--reallocate']), {
      fs,
      cwd: '/ws',
      log: out.sink,
      error: err.sink,
      portAvailable: (port) => Promise.resolve(port !== 3000 && port !== 3002),
    });

    expect(code).toBe(0);
    expect(fs.read(`/ws/${WORKSPACE_MANIFEST}`)).toContain('"port": 3001');
    expect(fs.read(`/ws/${WORKSPACE_MANIFEST}`)).toContain('"port": 3003');
    expect(fs.read('/ws/apps/orders/src/discovery/services.ts')).toContain('port: 3003');
    expect(out.text()).toContain('Reallocated workspace ports');
    expect(err.text()).toBe('');
  });

  it('requires the explicit maintenance action and leaves files untouched otherwise', async () => {
    const fs = createFakeFs();
    const err = createRecorder();
    const code = await runWorkspaceCommand(parseArgs(['ports']), {
      fs,
      cwd: '/ws',
      log: createRecorder().sink,
      error: err.sink,
    });
    expect(code).toBe(2);
    expect(err.text()).toContain('workspace ports --reallocate');
    expect(fs.writes).toEqual([]);
  });

  it('rejects --dir without a path before it can target the current workspace', async () => {
    const fs = createFakeFs({
      [`/ws/${WORKSPACE_MANIFEST}`]: renderWorkspaceManifest({
        version: WORKSPACE_VERSION,
        runtime: 'deno',
        basePort: 3000,
        transport: 'http',
        members: [{ name: 'orders', port: 3000 }],
      }),
      '/ws/apps/orders/.setu-member': '',
    });
    const err = createRecorder();

    const code = await runWorkspaceCommand(parseArgs(['ports', '--reallocate', '--dir']), {
      fs,
      cwd: '/ws',
      log: createRecorder().sink,
      error: err.sink,
    });

    expect(code).toBe(2);
    expect(err.text()).toContain('--dir needs a path');
    expect(fs.writes).toEqual([]);
  });

  it('prints help without reading a workspace', async () => {
    const out = createRecorder();
    expect(
      await runWorkspaceCommand(parseArgs(['--help']), {
        fs: createFakeFs(),
        cwd: '/ws',
        log: out.sink,
        error: createRecorder().sink,
      }),
    ).toBe(0);
    expect(out.text()).toContain('workspace ports --reallocate');
  });

  it('reports a missing workspace manifest without writing', async () => {
    const fs = createFakeFs();
    const err = createRecorder();
    expect(
      await runWorkspaceCommand(parseArgs(['ports', '--reallocate']), {
        fs,
        cwd: '/ws',
        log: createRecorder().sink,
        error: err.sink,
      }),
    ).toBe(1);
    expect(err.text()).toContain('not a Setu workspace');
    expect(fs.writes).toEqual([]);
  });

  it('reports exhaustion and leaves all managed files untouched', async () => {
    const fs = createFakeFs({
      [`/ws/${WORKSPACE_MANIFEST}`]: renderWorkspaceManifest({
        version: WORKSPACE_VERSION,
        runtime: 'deno',
        basePort: 65535,
        transport: 'http',
        members: [{ name: 'orders', port: 65535 }],
      }),
      '/ws/apps/orders/.setu-member': '',
    });
    const err = createRecorder();
    expect(
      await runWorkspaceCommand(parseArgs(['ports', '--reallocate']), {
        fs,
        cwd: '/ws',
        log: createRecorder().sink,
        error: err.sink,
        portAvailable: () => Promise.resolve(false),
      }),
    ).toBe(1);
    expect(err.text()).toContain('No bindable ports remain');
    expect(fs.writes).toEqual([]);
  });

  it('prints the reallocation plan without writing under --dry-run', async () => {
    const fs = createFakeFs({
      [`/ws/${WORKSPACE_MANIFEST}`]: renderWorkspaceManifest({
        version: WORKSPACE_VERSION,
        runtime: 'deno',
        basePort: 3000,
        transport: 'http',
        members: [{ name: 'orders', port: 3000 }],
      }),
      '/ws/apps/orders/.setu-member': '',
    });
    const out = createRecorder();
    expect(
      await runWorkspaceCommand(parseArgs(['ports', '--reallocate', '--dry-run']), {
        fs,
        cwd: '/ws',
        log: out.sink,
        error: createRecorder().sink,
        portAvailable: () => Promise.resolve(true),
      }),
    ).toBe(0);
    expect(out.text()).toContain('would update');
    expect(fs.writes).toEqual([]);
  });

  it('reports a filesystem write failure instead of throwing', async () => {
    const base = createFakeFs({
      [`/ws/${WORKSPACE_MANIFEST}`]: renderWorkspaceManifest({
        version: WORKSPACE_VERSION,
        runtime: 'deno',
        basePort: 3000,
        transport: 'http',
        members: [{ name: 'orders', port: 3000 }],
      }),
      '/ws/apps/orders/.setu-member': '',
    });
    const fs = { ...base, writeFile: () => Promise.reject(new Error('disk full')) };
    const err = createRecorder();
    expect(
      await runWorkspaceCommand(parseArgs(['ports', '--reallocate']), {
        fs,
        cwd: '/ws',
        log: createRecorder().sink,
        error: err.sink,
        portAvailable: () => Promise.resolve(true),
      }),
    ).toBe(1);
    expect(err.text()).toContain('disk full');
  });

  it('refuses a stale member before reallocating or writing', async () => {
    const fs = createFakeFs({
      [`/ws/${WORKSPACE_MANIFEST}`]: renderWorkspaceManifest({
        version: WORKSPACE_VERSION,
        runtime: 'deno',
        basePort: 3000,
        transport: 'http',
        members: [{ name: 'orders', port: 3000 }],
      }),
    });
    const err = createRecorder();
    expect(
      await runWorkspaceCommand(parseArgs(['ports', '--reallocate']), {
        fs,
        cwd: '/ws',
        log: () => {},
        error: err.sink,
      }),
    ).toBe(1);
    expect(err.text()).toContain('apps/orders does not exist');
    expect(fs.writes).toEqual([]);
  });

  it('reports an uninspectable member as an access problem, never as deleted', async () => {
    // Advising removal of the manifest entry here would delete a valid member
    // whose directory merely has a permission problem.
    const base = createFakeFs({
      [`/ws/${WORKSPACE_MANIFEST}`]: renderWorkspaceManifest({
        version: WORKSPACE_VERSION,
        runtime: 'deno',
        basePort: 3000,
        transport: 'http',
        members: [{ name: 'orders', port: 3000 }],
      }),
    });
    const fs = {
      ...base,
      stat: () => Promise.reject(new Error('permission denied')),
    };
    const err = createRecorder();
    expect(
      await runWorkspaceCommand(parseArgs(['ports', '--reallocate']), {
        fs,
        cwd: '/ws',
        log: () => {},
        error: err.sink,
      }),
    ).toBe(1);
    expect(err.text()).toContain('apps/orders cannot be inspected');
    expect(err.text()).toContain('access permissions');
    expect(err.text()).not.toContain('does not exist');
    expect(err.text()).not.toContain('Remove its entry');
    expect(base.writes).toEqual([]);
  });

  it('returns 130 when interrupted before its write batch', async () => {
    const fs = createFakeFs({
      [`/ws/${WORKSPACE_MANIFEST}`]: renderWorkspaceManifest({
        version: WORKSPACE_VERSION,
        runtime: 'deno',
        basePort: 3000,
        transport: 'http',
        members: [{ name: 'orders', port: 3000 }],
      }),
      '/ws/apps/orders/.setu-member': '',
    });
    const controller = new AbortController();
    controller.abort();
    const err = createRecorder();
    expect(
      await runWorkspaceCommand(parseArgs(['ports', '--reallocate']), {
        fs,
        cwd: '/ws',
        log: () => {},
        error: err.sink,
        interrupt: controller.signal,
      }),
    ).toBe(130);
    expect(err.text()).toContain('Interrupted;');
  });

  it('distinguishes unreadable and non-directory workspace members', async () => {
    const manifest = {
      version: WORKSPACE_VERSION,
      runtime: 'deno' as const,
      basePort: 3000,
      transport: 'http' as const,
      members: [{ name: 'orders', port: 3000 }],
    };
    const base = createFakeFs();
    expect(
      await reconcileMembers(
        {
          ...base,
          stat: () => Promise.reject(new Error('permission denied')),
        },
        '/ws',
        manifest,
      ),
    ).toEqual({ ok: false, member: 'orders', reason: 'unreadable' });
    expect(
      await reconcileMembers(
        createFakeFs({ '/ws/apps/orders': 'not a directory' }),
        '/ws',
        manifest,
      ),
    ).toEqual({ ok: false, member: 'orders', reason: 'missing' });
  });
});
