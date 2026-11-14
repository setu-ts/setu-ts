import { describe, expect, it } from 'vitest';

import type { IFileSystem } from '@setu-ts/common';

import {
  isMemberName,
  manifestProblemDetail,
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
  return { version: 2, basePort: 3000, broker: 'memory', runtime: 'deno', members };
}

describe('generatedSecrets in the workspace manifest', () => {
  it('round-trips valid names and drops absent or empty lists', async () => {
    for (const generatedSecrets of [undefined, [], ['SESSION_SECRET', 'JWT_SECRET']]) {
      const member = {
        name: 'web',
        port: 3000,
        ...(generatedSecrets === undefined ? {} : { generatedSecrets }),
      };
      const read = await readWorkspaceManifest(
        fsWith({
          '/ws/setu.workspace.json': renderWorkspaceManifest(baseManifest([member])),
        }),
        '/ws',
      );
      expect(read.ok).toBe(true);
      if (read.ok)
        expect(read.manifest.members[0]?.generatedSecrets).toEqual(
          generatedSecrets?.length ? generatedSecrets : undefined,
        );
    }
  });

  it.each([null, 'JWT_SECRET', [42], ['lower_case'], [''], ['_SECRET'], ['JWT-SECRET']])(
    'refuses malformed generated secrets %j',
    async (generatedSecrets) => {
      const source = {
        ...baseManifest([]),
        members: [{ name: 'web', port: 3000, generatedSecrets }],
      };
      expect(
        (
          await readWorkspaceManifest(
            fsWith({
              '/ws/setu.workspace.json': JSON.stringify(source),
            }),
            '/ws',
          )
        ).ok,
      ).toBe(false);
    },
  );

  it.each([42, '', '/abs.env', '../up.env', 'a//b.env', 'bad name.env'])(
    'refuses a member env file path outside the --env-file grammar (%j)',
    async (envFilePath) => {
      const source = { ...baseManifest([]), members: [{ name: 'web', port: 3000, envFilePath }] };
      expect(
        (
          await readWorkspaceManifest(
            fsWith({ '/ws/setu.workspace.json': JSON.stringify(source) }),
            '/ws',
          )
        ).ok,
      ).toBe(false);
    },
  );

  it('round-trips a member env file path', async () => {
    const read = await readWorkspaceManifest(
      fsWith({
        '/ws/setu.workspace.json': renderWorkspaceManifest(
          baseManifest([{ name: 'web', port: 3000, envFilePath: 'config/local.env' }]),
        ),
      }),
      '/ws',
    );
    expect(read.ok && read.manifest.members[0]?.envFilePath).toBe('config/local.env');
  });

  it('refuses two members whose secrets need the same Compose variable', async () => {
    const read = await readWorkspaceManifest(
      fsWith({
        '/ws/setu.workspace.json': renderWorkspaceManifest(
          baseManifest([
            { name: 'admin', port: 3000, generatedSecrets: ['WEB_SESSION_SECRET'] },
            { name: 'admin-web', port: 3001, generatedSecrets: ['SESSION_SECRET'] },
          ]),
        ),
      }),
      '/ws',
    );
    expect(read.ok).toBe(false);
    if (!read.ok) {
      expect(read.problem).toEqual({
        kind: 'secret-collision',
        variable: 'ADMIN_WEB_SESSION_SECRET',
        first: 'admin (WEB_SESSION_SECRET)',
        second: 'admin-web (SESSION_SECRET)',
      });
      expect(manifestProblemDetail(read.problem)).toBe(
        'Members admin (WEB_SESSION_SECRET) and admin-web (SESSION_SECRET) both need the Compose ' +
          'variable ADMIN_WEB_SESSION_SECRET, so they would share one signing key. Rename a member ' +
          'or its generated secret in the manifest.',
      );
    }
  });
});

it('X87-2 X87-6 round-trips and validates development ports without dropping fields', async () => {
  const manifest = {
    ...baseManifest([{ name: 'web', port: 3000, inspectPort: 5100, vitePort: 5101 }]),
    devBasePort: 5100,
  };
  expect(
    await readWorkspaceManifest(
      fsWith({ '/ws/setu.workspace.json': renderWorkspaceManifest(manifest) }),
      '/ws',
    ),
  ).toEqual({ ok: true, manifest });
  for (const field of ['inspectPort', 'vitePort', 'devBasePort'] as const)
    for (const value of [0, 65536, -1, 3.2, '5100', null]) {
      const source =
        field === 'devBasePort'
          ? { ...manifest, [field]: value }
          : { ...manifest, members: [{ ...manifest.members[0], [field]: value }] };
      expect(
        (
          await readWorkspaceManifest(
            fsWith({ '/ws/setu.workspace.json': JSON.stringify(source) }),
            '/ws',
          )
        ).ok,
      ).toBe(false);
    }
});

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
        '/ws/setu.workspace.json': renderWorkspaceManifest(
          baseManifest([{ name: 'orders', port: 3000 }]),
        ),
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

describe('member names in the workspace manifest (M139b audit F9)', () => {
  /** Reads a one-member manifest under a name. */
  async function readNamed(name: unknown): Promise<boolean> {
    const source = JSON.stringify({
      ...baseManifest([{ name: 'placeholder', port: 3000 }]),
      members: [{ name, port: 3000 }],
    });
    return (await readWorkspaceManifest(fsWith({ '/ws/setu.workspace.json': source }), '/ws')).ok;
  }

  it.each(['billing', 'orders', 'api-gateway', 'svc2', 'a'])('accepts %s', async (name) => {
    expect(await readNamed(name)).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['a separator', 'a/b'],
    ['a backslash', 'a\\b'],
    ['a dot segment', '..'],
    ['a single quote breaking an object key', "billing': (globalThis.CANARY = 1), '"],
    ['a JSDoc terminator', 'billing */ globalThis.CANARY = 1; /*'],
    ['a backtick', 'bill`ing'],
    ['a space', 'bill ing'],
    ['upper case (generate app writes kebab)', 'Billing'],
    ['an underscore (generate app writes kebab)', 'bill_ing'],
    ['a leading digit', '2fa'],
    ['a Windows device name', 'con'],
    ['not a string', 7],
  ])('refuses %s', async (_label, name) => {
    expect(await readNamed(name)).toBe(false);
  });

  it('isMemberName agrees with what generate app derives', () => {
    expect(isMemberName('api-gateway')).toBe(true);
    expect(isMemberName("x'y")).toBe(false);
  });
});
