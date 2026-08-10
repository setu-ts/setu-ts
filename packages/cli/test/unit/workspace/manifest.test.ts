import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createFakeFs } from '../../fixtures/fake-fs.ts';
import {
  allocatePort,
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
        basePort: 3000,
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

  it('reports a non-integer basePort', async () => {
    const result = await readWorkspaceManifest(
      workspace(`{"version":${WORKSPACE_VERSION},"basePort":30.5,"members":[]}`),
      '/ws',
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem.kind).toBe('malformed');
  });

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
      ['an entry with a fractional port', '{"name":"orders","port":30.5}'],
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
});

describe('renderWorkspaceManifest', () => {
  it('round-trips through the reader', async () => {
    const manifest: WorkspaceManifest = {
      version: WORKSPACE_VERSION,
      basePort: 4100,
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
      basePort: 3000,
      members: [],
    });
    expect(rendered.endsWith('\n')).toBe(true);
  });
});

describe('allocatePort', () => {
  it('gives the first member the base port', () => {
    expect(allocatePort({ version: WORKSPACE_VERSION, basePort: 3000, members: [] })).toBe(3000);
  });

  it('gives the next member one above the highest in use', () => {
    expect(
      allocatePort({
        version: WORKSPACE_VERSION,
        basePort: 3000,
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
        basePort: 3000,
        members: [{ name: 'a', port: 4100 }, { name: 'b', port: 3001 }],
      }),
    ).toBe(4101);
  });

  // Member order comes from a file a human may reorder.
  it('does not depend on member order', () => {
    const ports = [{ name: 'a', port: 3005 }, { name: 'b', port: 3001 }];
    const forwards = allocatePort({ version: WORKSPACE_VERSION, basePort: 3000, members: ports });
    const backwards = allocatePort({
      version: WORKSPACE_VERSION,
      basePort: 3000,
      members: [...ports].reverse(),
    });
    expect(forwards).toBe(backwards);
    expect(forwards).toBe(3006);
  });
});
