import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { allocatePort, type WorkspaceManifest } from '../../src/workspace/manifest.ts';

function manifest(members: WorkspaceManifest['members'], basePort = 3000): WorkspaceManifest {
  return {
    version: 1,
    basePort,
    transport: 'http',
    runtime: 'deno',
    members,
  };
}

describe('allocatePort', () => {
  it('allocates one above the highest application port', () => {
    expect(allocatePort(manifest([{ name: 'a', port: 3000 }]))).toBe(3001);
  });

  it('walks a member devtool port, so allocation never hands out a held port', () => {
    // A devtool port HIGHER than every application port would otherwise be
    // invisible to the allocator, and the next member would be handed it.
    const port = allocatePort(manifest([
      { name: 'a', port: 3000, devtoolPort: 4919 },
    ]));
    expect(port).toBe(4920);
  });

  it('walks a devtool port that is the highest value in the workspace', () => {
    // The widening is a MAXIMUM over the whole 2N-value space, not an offset:
    // the next allocation lands above whatever any member holds, application
    // or devtool alike.
    const port = allocatePort(manifest([
      { name: 'a', port: 3000, devtoolPort: 4000 },
      { name: 'b', port: 3100 },
    ]));
    expect(port).toBe(4001);
  });

  it('returns undefined when a devtool port has spent the range', () => {
    expect(allocatePort(manifest([{ name: 'a', port: 65535, devtoolPort: 65534 }])))
      .toBeUndefined();
  });

  it('allocates the application port before the devtool port for the same member', () => {
    // `generate app --devtool` allocates from the manifest AS IT WILL BE, with
    // the pending member's application port recorded, so the devtool port can
    // never equal the port that very member binds.
    const pending: WorkspaceManifest = {
      version: 1,
      basePort: 3000,
      transport: 'http',
      runtime: 'deno',
      members: [{ name: 'a', port: 3000 }, { name: 'pending', port: 3001 }],
    };
    expect(allocatePort(pending)).toBe(3002);
  });
});
