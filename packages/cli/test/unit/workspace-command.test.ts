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
});
