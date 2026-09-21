import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { createFakeFs, createRecorder } from '../fixtures/fake-fs.ts';
import { parseArgs } from '../../src/args.ts';
import { runWorkspaceCommand } from '../../src/commands/workspace.ts';
import {
  renderWorkspaceManifest,
  WORKSPACE_MANIFEST,
  WORKSPACE_VERSION,
  type WorkspaceMember,
} from '../../src/workspace/manifest.ts';
import { DISCOVERY_MODULE } from '../../src/workspace/discovery-module.ts';

function harness(members: readonly WorkspaceMember[]) {
  const fs = createFakeFs({
    [`/ws/${WORKSPACE_MANIFEST}`]: renderWorkspaceManifest({
      version: WORKSPACE_VERSION,
      runtime: 'deno',
      basePort: 3000,
      transport: 'http',
      members,
    }),
    '/ws/deno.json': '{"workspace":["./apps/*"]}',
  });
  const log = createRecorder();
  return {
    fs,
    log,
    run: () =>
      runWorkspaceCommand(parseArgs(['ports', '--reallocate']), {
        fs,
        cwd: '/ws',
        log: log.sink,
        error: () => {},
        portAvailable: () => Promise.resolve(true),
      }),
  };
}

describe('ports --reallocate', () => {
  it('moves a member application port and devtool port together', async () => {
    const h = harness([
      { name: 'orders', port: 3000, devtoolPort: 4919 },
      { name: 'billing', port: 3100 },
    ]);
    expect(await h.run()).toBe(0);

    const manifest = JSON.parse(h.fs.read(`/ws/${WORKSPACE_MANIFEST}`)) as {
      members: WorkspaceMember[];
    };
    expect(manifest.members[0].port).toBe(3000);
    expect(manifest.members[0].devtoolPort).toBe(3001);
    // The second member's application port starts AFTER the first member's
    // devtool port — the two addresses moved as one unit.
    expect(manifest.members[1].port).toBe(3002);
    expect(manifest.members[1].devtoolPort).toBeUndefined();

    // The devtool port the discovery modules render is the application port,
    // so the regenerated map must name the new application address.
    const discovery = h.fs.read(`/ws/apps/billing/${DISCOVERY_MODULE}`);
    expect(discovery).toContain('port: 3000');
  });

  it('gains no devtool port for a member that carried none', async () => {
    const h = harness([{ name: 'orders', port: 3000 }]);
    expect(await h.run()).toBe(0);
    const manifest = JSON.parse(h.fs.read(`/ws/${WORKSPACE_MANIFEST}`)) as {
      members: WorkspaceMember[];
    };
    expect(manifest.members[0].devtoolPort).toBeUndefined();
  });

  it('skips an occupied port for the devtool address too', async () => {
    const fs = createFakeFs({
      [`/ws/${WORKSPACE_MANIFEST}`]: renderWorkspaceManifest({
        version: WORKSPACE_VERSION,
        runtime: 'deno',
        basePort: 3000,
        transport: 'http',
        members: [{ name: 'orders', port: 3000, devtoolPort: 4919 }],
      }),
      '/ws/deno.json': '{"workspace":["./apps/*"]}',
    });
    const occupied = new Set([3000, 3001]);
    let code = 0;
    code = await runWorkspaceCommand(parseArgs(['ports', '--reallocate']), {
      fs,
      cwd: '/ws',
      log: () => {},
      error: () => {},
      portAvailable: (port) => Promise.resolve(!occupied.has(port)),
    });
    expect(code).toBe(0);
    const manifest = JSON.parse(fs.read(`/ws/${WORKSPACE_MANIFEST}`)) as {
      members: WorkspaceMember[];
    };
    expect(manifest.members[0].port).toBe(3002);
    expect(manifest.members[0].devtoolPort).toBe(3003);
  });
});
