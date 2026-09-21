import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type { IFileSystem } from '@setu-ts/common';

import {
  readWorkspaceManifest,
  renderWorkspaceManifest,
  WORKSPACE_VERSION,
  type WorkspaceManifest,
} from '../../src/workspace/manifest.ts';

/** An in-memory filesystem holding one file. */
function fsWith(files: Record<string, string>): IFileSystem {
  return {
    readFile: (path: string) => {
      const contents = files[path];
      if (contents === undefined) return Promise.reject(new Error('missing'));
      return Promise.resolve(new TextEncoder().encode(contents));
    },
  } as unknown as IFileSystem;
}

function baseManifest(members: WorkspaceManifest['members']): WorkspaceManifest {
  return { version: 1, basePort: 3000, transport: 'http', runtime: 'deno', members };
}

describe('devtoolPort in the workspace manifest', () => {
  it('round-trips through render and read', async () => {
    const manifest = baseManifest([{ name: 'orders', port: 3000, devtoolPort: 4919 }]);
    const read = await readWorkspaceManifest(
      fsWith({ '/ws/setu.workspace.json': renderWorkspaceManifest(manifest) }),
      '/ws',
    );
    expect(read).toEqual({
      ok: true,
      manifest: { ...manifest, members: [{ name: 'orders', port: 3000, devtoolPort: 4919 }] },
    });
  });

  it('absent stays absent', async () => {
    const read = await readWorkspaceManifest(
      fsWith({
        '/ws/setu.workspace.json': renderWorkspaceManifest(baseManifest([
          { name: 'orders', port: 3000 },
        ])),
      }),
      '/ws',
    );
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.manifest.members[0].devtoolPort).toBeUndefined();
  });

  it('range-checks a devtool port on read, naming the member and field', async () => {
    const manifest = baseManifest([{ name: 'orders', port: 3000, devtoolPort: 70000 }]);
    const read = await readWorkspaceManifest(
      fsWith({ '/ws/setu.workspace.json': renderWorkspaceManifest(manifest) }),
      '/ws',
    );
    expect(read).toEqual({
      ok: false,
      problem: { kind: 'invalid-port', port: 70000, field: 'member "orders" devtoolPort' },
    });
  });

  /**
   * A DEFINED but wrong-shaped devtool port is malformed, not absent.
   *
   * Dropping it — the shape the two boolean siblings use — made the member read
   * as devtool-disabled, so `ports --reallocate` rewrote the manifest WITHOUT
   * the field and reported success, while the member's `main.dev.ts` went on
   * binding the old number and the launcher had nothing left to dial. That is
   * the caller's own rule ("one bad entry invalidates the manifest rather than
   * being dropped") applied one level down.
   */
  it('refuses a defined non-numeric devtool port rather than silently dropping it', async () => {
    for (const bad of ['4919', true, null, { port: 4919 }]) {
      const source = JSON.stringify({
        version: WORKSPACE_VERSION,
        runtime: 'deno',
        basePort: 3000,
        transport: 'http',
        members: [{ name: 'orders', port: 3000, devtoolPort: bad }],
      });
      const read = await readWorkspaceManifest(
        fsWith({ '/ws/setu.workspace.json': source }),
        '/ws',
      );
      expect(read, `devtoolPort: ${JSON.stringify(bad)}`).toEqual({
        ok: false,
        problem: { kind: 'malformed' },
      });
    }
  });

  it('still accepts members sharing a port, exactly as before the devtool', () => {
    // Uniqueness is enforced at the two write sites (allocation and the
    // explicit-flag refusals); a read-time duplicate check would refuse
    // manifests the CLI accepts today — a behaviour change to every workspace,
    // not a devtool concern (M98c §3.3, pinned here so a later tightening is
    // deliberate).
    const manifest = baseManifest([
      { name: 'a', port: 3000 },
      { name: 'b', port: 3000 },
    ]);
    const files = { '/ws/setu.workspace.json': renderWorkspaceManifest(manifest) };
    // The write must parse; the reader accepts both members.
    return readWorkspaceManifest(fsWith(files), '/ws').then((read) => {
      expect(read.ok).toBe(true);
    });
  });
});
