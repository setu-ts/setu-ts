import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { parseArgs } from '../../src/args.ts';
import { runWorkspaceCommand } from '../../src/commands/workspace.ts';
import { createFakeFs, createRecorder } from '../fixtures/fake-fs.ts';
import {
  renderWorkspaceManifest,
  WORKSPACE_MANIFEST,
  WORKSPACE_VERSION,
} from '../../src/workspace/manifest.ts';

describe('runWorkspaceCommand', () => {
  it('reallocates every member to a bindable port and refreshes discovery maps', async () => {
    const fs = createFakeFs({
      [`/ws/${WORKSPACE_MANIFEST}`]: renderWorkspaceManifest({
        version: WORKSPACE_VERSION,
        runtime: 'deno',
        basePort: 3000,
        transport: 'http',
        members: [{ name: 'orders', port: 3000 }, { name: 'billing', port: 3001 }],
      }),
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
});
