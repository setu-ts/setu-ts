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

  it('keeps applications in their own sequence after a connector port is allocated', () => {
    // The M101f F1 regression: a connector at basePort + 1000 must not drag
    // the next application up past it — walking `devtoolPort` as part of the
    // maximum put every later member inside the connector range.
    const port = allocatePort(manifest([
      { name: 'a', port: 3000, devtoolPort: 4000 },
      { name: 'b', port: 3001 },
    ]));
    expect(port).toBe(3002);
  });

  it('skips a candidate a connector already holds, so allocation never hands out a held port', () => {
    // An overlapping or hand-edited connector range can sit directly above the
    // application ports; the next application must step over it, not onto it.
    const port = allocatePort(manifest([
      { name: 'a', port: 3000, devtoolPort: 3001 },
      { name: 'b', port: 3100, devtoolPort: 3101 },
    ]));
    expect(port).toBe(3102);
  });

  it('returns undefined when skipping connector ports exhausts the range', () => {
    expect(allocatePort(manifest([{ name: 'a', port: 65534, devtoolPort: 65535 }])))
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
