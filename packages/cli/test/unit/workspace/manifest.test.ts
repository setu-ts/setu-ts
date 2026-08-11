import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createFakeFs } from '../../fixtures/fake-fs.ts';
import {
  allocatePort,
  isUsablePort,
  MAX_PORT,
  MIN_PORT,
  readWorkspaceManifest,
  renderWorkspaceManifest,
  WORKSPACE_MANIFEST,
  WORKSPACE_VERSION,
  type WorkspaceManifest,
} from '../../../src/workspace/manifest.ts';

/**
 * Seeds a workspace root holding the given manifest text.
 *
 * @param contents - The manifest file's contents
 * @returns A fake filesystem rooted at `/ws`
 */
function workspace(contents: string) {
  return createFakeFs({ [`/ws/${WORKSPACE_MANIFEST}`]: contents });
}

describe('readWorkspaceManifest', () => {
  it('reads a well-formed manifest', async () => {
    const fs = workspace(
      renderWorkspaceManifest({
        version: WORKSPACE_VERSION,
        runtime: 'deno',
        basePort: 3000,
        transport: 'http',
        members: [{ name: 'orders', port: 3000 }],
      }),
    );
    const result = await readWorkspaceManifest(fs, '/ws');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.basePort).toBe(3000);
    expect(result.manifest.members).toEqual([{ name: 'orders', port: 3000 }]);
  });

  // "Not a workspace" and "this workspace is broken" need different advice, so
  // the two are reported distinctly rather than as one failure.
  it('reports an absent manifest as absent, not malformed', async () => {
    const result = await readWorkspaceManifest(createFakeFs(), '/ws');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem.kind).toBe('absent');
  });

  it('reports malformed JSON', async () => {
    const result = await readWorkspaceManifest(workspace('{ not json'), '/ws');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem.kind).toBe('malformed');
  });

  it('reports a JSON value that is not an object', async () => {
    const result = await readWorkspaceManifest(workspace('[]'), '/ws');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem.kind).toBe('malformed');
  });

  it('reports a null document', async () => {
    const result = await readWorkspaceManifest(workspace('null'), '/ws');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem.kind).toBe('malformed');
  });

  it('reports a missing version', async () => {
    const result = await readWorkspaceManifest(
      workspace('{"basePort":3000,"members":[]}'),
      '/ws',
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem.kind).toBe('malformed');
  });

  // A version this CLI does not know must never be read with a guessed shape.
  it('reports an unsupported version, carrying the number', async () => {
    const result = await readWorkspaceManifest(
      workspace('{"version":99,"basePort":3000,"members":[]}'),
      '/ws',
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem.kind).toBe('unsupported-version');
    if (result.problem.kind !== 'unsupported-version') return;
    expect(result.problem.version).toBe(99);
  });

  // A fractional basePort is reported as the unusable PORT it is rather than as
  // an unreadable manifest: "this is not a readable workspace manifest" would
  // send a developer hunting for a syntax error in a file whose only problem is
  // one number.
  it('reports a non-integer basePort as an invalid port', async () => {
    const result = await readWorkspaceManifest(
      workspace(`{"version":${WORKSPACE_VERSION},"basePort":30.5,"members":[]}`),
      '/ws',
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem.kind).toBe('invalid-port');
  });

  it('reports a transportUrl that is not a string', async () => {
    const result = await readWorkspaceManifest(
      workspace(
        `{"version":${WORKSPACE_VERSION},"basePort":3000,"transport":"redis",` +
          `"transportUrl":42,"members":[]}`,
      ),
      '/ws',
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem.kind).toBe('malformed');
  });

  // Absent → http, so a workspace created before the transport choice existed
  // keeps working and keeps its behaviour.
  it('defaults an absent transport to http rather than refusing', async () => {
    const result = await readWorkspaceManifest(
      workspace(`{"version":${WORKSPACE_VERSION},"basePort":3000,"members":[]}`),
      '/ws',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.transport).toBe('http');
    expect(result.manifest.transportUrl).toBeUndefined();
  });

  it('reads a transport and its endpoint back', async () => {
    const result = await readWorkspaceManifest(
      workspace(
        `{"version":${WORKSPACE_VERSION},"basePort":3000,"transport":"redis",` +
          `"transportUrl":"redis://shared:6379","members":[]}`,
      ),
      '/ws',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.transport).toBe('redis');
    expect(result.manifest.transportUrl).toBe('redis://shared:6379');
  });

  // Refused rather than defaulted: quietly moving every member off the bus the
  // manifest asked for would leave services that cannot reach each other.
  for (const [label, value] of [['an unknown name', '"carrier-pigeon"'], ['a number', '42']]) {
    it(`refuses ${label} as the transport`, async () => {
      const result = await readWorkspaceManifest(
        workspace(
          `{"version":${WORKSPACE_VERSION},"basePort":3000,"transport":${value},"members":[]}`,
        ),
        '/ws',
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.problem.kind).toBe('unknown-transport');
    });
  }

  it('reports a missing basePort', async () => {
    const result = await readWorkspaceManifest(
      workspace(`{"version":${WORKSPACE_VERSION},"members":[]}`),
      '/ws',
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem.kind).toBe('malformed');
  });

  it('reports members that are not an array', async () => {
    const result = await readWorkspaceManifest(
      workspace(`{"version":${WORKSPACE_VERSION},"basePort":3000,"members":{}}`),
      '/ws',
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem.kind).toBe('malformed');
  });

  // One bad entry invalidates the manifest rather than being dropped: a
  // silently omitted member is one every sibling's map stops naming, and the
  // CLI would then hand its port to someone else.
  for (
    const [label, entry] of [
      ['a non-object entry', '"orders"'],
      ['a null entry', 'null'],
      ['an entry with no name', '{"port":3000}'],
      ['an entry with an empty name', '{"name":"","port":3000}'],
      ['an entry with no port', '{"name":"orders"}'],
      ['an entry whose port is not a number', '{"name":"orders","port":"3000"}'],
    ] as const
  ) {
    it(`reports ${label}`, async () => {
      const result = await readWorkspaceManifest(
        workspace(`{"version":${WORKSPACE_VERSION},"basePort":3000,"members":[${entry}]}`),
        '/ws',
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.problem.kind).toBe('malformed');
    });
  }

  // A port outside the bindable range is checked on the way IN, because every
  // one of them is written into a member's own entry point AND into every
  // sibling's discovery map. Verified against the real kernel: `app.start()`
  // throws `Invalid port (out of range)` for 99999 and -1, while 0 BINDS on an
  // arbitrary free port — so the member starts, looks healthy, and every sibling
  // dialling 0 is refused. All three must be refused here, not propagated.
  for (const port of [99999, 0, -1, 65536, 30.5]) {
    it(`refuses a member port of ${port}, naming the value and the member`, async () => {
      const result = await readWorkspaceManifest(
        workspace(
          `{"version":${WORKSPACE_VERSION},"basePort":3000,` +
            `"members":[{"name":"orders","port":${port}}]}`,
        ),
        '/ws',
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.problem.kind).toBe('invalid-port');
      if (result.problem.kind !== 'invalid-port') return;
      expect(result.problem.port).toBe(port);
      expect(result.problem.field).toContain('orders');
    });
  }

  it('refuses an out-of-range basePort, naming the field', async () => {
    const result = await readWorkspaceManifest(
      workspace(`{"version":${WORKSPACE_VERSION},"basePort":99999,"members":[]}`),
      '/ws',
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem.kind).toBe('invalid-port');
    if (result.problem.kind !== 'invalid-port') return;
    expect(result.problem.field).toBe('basePort');
  });

  it('reports a basePort that is not a number as malformed, not as a bad port', async () => {
    const result = await readWorkspaceManifest(
      workspace(`{"version":${WORKSPACE_VERSION},"basePort":"3000","members":[]}`),
      '/ws',
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem.kind).toBe('malformed');
  });

  it('accepts the range boundaries', async () => {
    const result = await readWorkspaceManifest(
      workspace(
        `{"version":${WORKSPACE_VERSION},"basePort":1,` +
          `"members":[{"name":"a","port":1},{"name":"b","port":65535}]}`,
      ),
      '/ws',
    );
    expect(result.ok).toBe(true);
  });
});

describe('isUsablePort', () => {
  it('accepts the whole bindable range and nothing outside it', () => {
    for (const usable of [MIN_PORT, 3000, MAX_PORT]) {
      expect(isUsablePort(usable)).toBe(true);
    }
    // 0 binds an arbitrary free port rather than failing, which is why it is
    // excluded here rather than left to `app.start()` to reject.
    for (const unusable of [0, -1, MAX_PORT + 1, 30.5, Number.NaN, '3000', null, undefined]) {
      expect(isUsablePort(unusable)).toBe(false);
    }
  });
});

describe('renderWorkspaceManifest', () => {
  it('round-trips through the reader', async () => {
    const manifest: WorkspaceManifest = {
      version: WORKSPACE_VERSION,
      runtime: 'deno',
      basePort: 4100,
      transport: 'http',
      members: [{ name: 'orders', port: 4100 }, { name: 'billing', port: 4101 }],
    };
    const result = await readWorkspaceManifest(
      workspace(renderWorkspaceManifest(manifest)),
      '/ws',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest).toEqual(manifest);
  });

  it('ends in a newline, so the file is not truncated on the last line', () => {
    const rendered = renderWorkspaceManifest({
      version: WORKSPACE_VERSION,
      runtime: 'deno',
      basePort: 3000,
      transport: 'http',
      members: [],
    });
    expect(rendered.endsWith('\n')).toBe(true);
  });
});

describe('allocatePort', () => {
  it('gives the first member the base port', () => {
    expect(
      allocatePort({
        version: WORKSPACE_VERSION,
        runtime: 'deno',
        basePort: 3000,
        transport: 'http',
        members: [],
      }),
    ).toBe(3000);
  });

  it('gives the next member one above the highest in use', () => {
    expect(
      allocatePort({
        version: WORKSPACE_VERSION,
        runtime: 'deno',
        basePort: 3000,
        transport: 'http',
        members: [{ name: 'a', port: 3000 }, { name: 'b', port: 3001 }],
      }),
    ).toBe(3002);
  });

  // Derived from the MAXIMUM, not the count: a member hand-edited to a higher
  // port must not have that port handed to someone else.
  it('respects a member hand-edited above the base', () => {
    expect(
      allocatePort({
        version: WORKSPACE_VERSION,
        runtime: 'deno',
        basePort: 3000,
        transport: 'http',
        members: [{ name: 'a', port: 4100 }, { name: 'b', port: 3001 }],
      }),
    ).toBe(4101);
  });

  // Member order comes from a file a human may reorder.
  it('does not depend on member order', () => {
    const ports = [{ name: 'a', port: 3005 }, { name: 'b', port: 3001 }];
    const forwards = allocatePort({
      version: WORKSPACE_VERSION,
      runtime: 'deno',
      basePort: 3000,
      transport: 'http',
      members: ports,
    });
    const backwards = allocatePort({
      version: WORKSPACE_VERSION,
      runtime: 'deno',
      basePort: 3000,
      transport: 'http',
      members: [...ports].reverse(),
    });
    expect(forwards).toBe(backwards);
    expect(forwards).toBe(3006);
  });

  // 65536 is not a port. Handing it out would write a `main.ts` that throws
  // `Invalid port (out of range)` the first time it runs.
  it('reports exhaustion rather than allocating past the range', () => {
    expect(
      allocatePort({
        version: WORKSPACE_VERSION,
        runtime: 'deno',
        basePort: MAX_PORT,
        transport: 'http',
        members: [{ name: 'a', port: MAX_PORT }],
      }),
    ).toBeUndefined();
  });

  it('still allocates the last usable port', () => {
    expect(
      allocatePort({
        version: WORKSPACE_VERSION,
        runtime: 'deno',
        basePort: MAX_PORT - 1,
        transport: 'http',
        members: [{ name: 'a', port: MAX_PORT - 1 }],
      }),
    ).toBe(MAX_PORT);
  });
});
