import { describe, expect, it } from 'vitest';
import { createFakeFs } from '../fixtures/fake-fs.ts';
import { createFakeApp } from '../fixtures/fake-app.ts';
import { renderWorkspaceManifest } from '../../src/workspace/manifest.ts';
import {
  configModuleExists,
  configModulePath,
  denoInstallRefusal,
  installSearchDirs,
  loadApp,
  parentDir,
} from '../../src/app-loader.ts';

describe('configModulePath', () => {
  it('defaults to setu.config.ts at the project root', () => {
    expect(configModulePath('/app')).toBe('/app/setu.config.ts');
  });

  it('treats an empty --config as absent', () => {
    expect(configModulePath('/app', '')).toBe('/app/setu.config.ts');
  });

  it('passes an absolute --config through', () => {
    expect(configModulePath('/app', '/elsewhere/wiring.ts')).toBe('/elsewhere/wiring.ts');
  });

  it('anchors a relative --config to the project root', () => {
    expect(configModulePath('/app', 'config/app.ts')).toBe('/app/config/app.ts');
  });
});

describe('configModuleExists', () => {
  it('is true when the module is present', async () => {
    const fs = createFakeFs({ '/app/setu.config.ts': 'export function createApp() {}' });
    expect(await configModuleExists(fs, '/app')).toBe(true);
  });

  it('is false when it is absent', async () => {
    expect(await configModuleExists(createFakeFs(), '/app')).toBe(false);
  });

  it('honours the --config override', async () => {
    const fs = createFakeFs({ '/app/wiring.ts': 'x' });
    expect(await configModuleExists(fs, '/app', 'wiring.ts')).toBe(true);
    expect(await configModuleExists(fs, '/app')).toBe(false);
  });
});

describe('loadApp', () => {
  const app = createFakeApp();

  it('returns the application the factory produces', async () => {
    const loaded = await loadApp('/app', undefined, () =>
      Promise.resolve({ createApp: () => app }),
    );
    expect(loaded).toBe(app);
  });

  it('awaits an async factory', async () => {
    const loaded = await loadApp('/app', undefined, () =>
      Promise.resolve({ createApp: () => Promise.resolve(app) }),
    );
    expect(loaded).toBe(app);
  });

  it('does not start the application it loads', async () => {
    const fresh = createFakeApp();
    await loadApp('/app', undefined, () => Promise.resolve({ createApp: () => fresh }));
    expect(fresh.startCalls).toEqual([]);
  });

  it('imports the resolved absolute file URL', async () => {
    let seen: string | undefined;
    await loadApp('/app', undefined, (url) => {
      seen = url;
      return Promise.resolve({ createApp: () => app });
    });
    expect(seen).toBe('file:///app/setu.config.ts');
  });

  it('imports the --config override', async () => {
    let seen: string | undefined;
    await loadApp('/app', 'config/wiring.ts', (url) => {
      seen = url;
      return Promise.resolve({ createApp: () => app });
    });
    expect(seen).toBe('file:///app/config/wiring.ts');
  });

  it('throws naming the path when the module cannot be imported', async () => {
    await expect(
      loadApp('/app', undefined, () => Promise.reject(new Error('not found'))),
    ).rejects.toThrow('Cannot load file:///app/setu.config.ts');
  });

  it('preserves the import failure as the cause', async () => {
    const cause = new Error('boom');
    await loadApp('/app', undefined, () => Promise.reject(cause)).catch((error) => {
      expect((error as Error).cause).toBe(cause);
    });
  });

  it('reports a non-Error import rejection', async () => {
    await expect(loadApp('/app', undefined, () => Promise.reject('plain'))).rejects.toThrow(
      'plain',
    );
  });

  it('throws naming the expected export when it is missing', async () => {
    await expect(loadApp('/app', undefined, () => Promise.resolve({}))).rejects.toThrow(
      "must export a 'createApp' function",
    );
  });

  it('throws when the export is not a function', async () => {
    await expect(
      loadApp('/app', undefined, () => Promise.resolve({ createApp: 42 })),
    ).rejects.toThrow('found number');
  });

  it('throws naming the factory when it rejects', async () => {
    await expect(
      loadApp('/app', undefined, () =>
        Promise.resolve({
          createApp: () => {
            throw new Error('missing DATABASE_URL');
          },
        }),
      ),
    ).rejects.toThrow('createApp() in file:///app/setu.config.ts threw: missing DATABASE_URL');
  });

  it('reports a non-Error factory throw', async () => {
    await expect(
      loadApp('/app', undefined, () =>
        Promise.resolve({
          createApp: () => {
            throw 'bare';
          },
        }),
      ),
    ).rejects.toThrow('bare');
  });

  describe('validating what the factory returned', () => {
    // Checked where the seam is injected, so a wrong shape fails immediately
    // rather than somewhere inside dispatch.
    const cases: readonly (readonly [string, unknown])[] = [
      ['null', null],
      ['a string', 'not an app'],
      ['a number', 7],
      ['an object with no lifecycle', { router: {} }],
      ['an object missing stop', { start: () => {}, services: {} }],
      ['an object missing services', { start: () => {}, stop: () => {} }],
    ];

    for (const [label, value] of cases) {
      it(`rejects ${label}`, async () => {
        await expect(
          loadApp('/app', undefined, () => Promise.resolve({ createApp: () => value })),
        ).rejects.toThrow('must return the application from createApplication()');
      });
    }
  });
});

// X9-3. `setu commands` builds the application to discover plugin verbs, and a
// Workers factory takes the platform `env`. The scaffolded `{}` default survived
// only while nothing READ a binding — but every documented binding-backed
// composition constructs eagerly in the plugin list, so the moment a project
// followed the D1 or session docs, `setu commands` and every plugin verb stopped
// working with an error the developer could not act on.
describe('loadApp — discovery-time platform bindings', () => {
  const app = createFakeApp();

  /** Every binding guard `cloudflare-plugin` ships is a `hasMethods` check. */
  const GUARD_METHODS: readonly (readonly string[])[] = [
    ['get', 'put', 'delete', 'list'], // isKvNamespace
    ['head', 'get', 'put', 'delete'], // isR2Bucket
    ['prepare', 'batch'], // isD1Database
    ['send', 'sendBatch'], // isQueueProducer
    ['idFromName', 'get'], // isDurableObjectNamespace
  ];

  it('hands the factory an env whose bindings satisfy every guard', async () => {
    let seen: Readonly<Record<string, unknown>> | undefined;
    await loadApp('/app', undefined, () =>
      Promise.resolve({
        createApp: (env: Readonly<Record<string, unknown>>) => {
          seen = env;
          return app;
        },
      }),
    );

    expect(seen).toBeDefined();
    for (const methods of GUARD_METHODS) {
      const binding = seen?.['ANY_BINDING_NAME'] as Record<string, unknown>;
      for (const method of methods) {
        expect(typeof binding[method]).toBe('function');
      }
    }
  });

  it('throws if a binding is CALLED, rather than faking I/O', async () => {
    // Discovery must not silently perform I/O against a stub. No discovery path
    // invokes a binding; one that did would be a bug worth hearing about.
    await expect(
      loadApp('/app', undefined, () =>
        Promise.resolve({
          createApp: (env: Readonly<Record<string, unknown>>) => {
            (env['DB'] as { prepare: () => unknown }).prepare();
            return app;
          },
        }),
      ),
    ).rejects.toThrow('CALLED during command discovery');
  });

  it('frames a construction failure as unavailable commands, not a binding error', async () => {
    // The old message was correct and useless: the binding was absent because
    // the CLI passed no env, not because wrangler.toml was wrong.
    await expect(
      loadApp('/app', undefined, () =>
        Promise.resolve({
          createApp: () => {
            throw new Error('D1Adapter needs a D1 binding');
          },
        }),
      ),
    ).rejects.toThrow('Plugin commands are unavailable in this project');
  });
});

/** A workspace manifest this CLI can read, listing the named members. */
const workspace = (...members: string[]) =>
  renderWorkspaceManifest({
    version: 1,
    basePort: 3000,
    runtime: 'deno',
    transport: 'http',
    members: members.map((name, index) => ({ name, port: 3000 + index })),
  });

describe('denoInstallRefusal', () => {
  it('passes a project with no Deno manifest', async () => {
    const fs = createFakeFs({ '/app/package.json': '{}' });
    expect(await denoInstallRefusal(fs, '/app')).toBeUndefined();
  });

  it('passes a Deno project whose framework packages are linked', async () => {
    const fs = createFakeFs({
      '/app/deno.json': '{"nodeModulesDir":"auto"}',
      '/app/node_modules/@setu-ts/kernel/package.json': '{}',
    });
    expect(await denoInstallRefusal(fs, '/app')).toBeUndefined();
  });

  it('passes a workspace member satisfied by the root node_modules', async () => {
    const fs = createFakeFs({
      '/ws/setu.workspace.json': workspace('api'),
      '/ws/apps/api/deno.json': '{}',
      '/ws/node_modules/@setu-ts/kernel/package.json': '{}',
    });
    expect(await denoInstallRefusal(fs, '/ws/apps/api')).toBeUndefined();
  });

  // M111d audit round 2, N1: a kernel planted in a shared parent (`/tmp`) must
  // not count as installed — Node would import and run it. The search reaches
  // no higher than the project, or the workspace root when it is a member.
  it('ignores a kernel in an ancestor outside the project', async () => {
    const fs = createFakeFs({
      '/tmp/app/deno.json': '{}',
      '/tmp/node_modules/@setu-ts/kernel/package.json': '{}',
    });
    expect(await denoInstallRefusal(fs, '/tmp/app')).toContain('deno install');
  });

  it('ignores a kernel above the workspace root', async () => {
    const fs = createFakeFs({
      '/tmp/ws/setu.workspace.json': workspace('api'),
      '/tmp/ws/apps/api/deno.json': '{}',
      '/tmp/node_modules/@setu-ts/kernel/package.json': '{}',
    });
    expect(await denoInstallRefusal(fs, '/tmp/ws/apps/api')).toContain('deno install');
  });

  // PR #450 review: the mere presence of a workspace manifest must not widen
  // the search. A planted `{}` beside a planted kernel, a manifest that does not
  // list this project, or one listing it at another path, leaves the project
  // to its own `node_modules`.
  it('does not trust a workspace manifest that does not list the project', async () => {
    const cases: readonly (readonly [string, string, string])[] = [
      ['/tmp/setu.workspace.json', '{}', '/tmp/app'],
      ['/tmp/setu.workspace.json', workspace('other'), '/tmp/apps/app'],
      ['/tmp/setu.workspace.json', workspace('app'), '/tmp/app'],
    ];
    for (const [path, contents, project] of cases) {
      const fs = createFakeFs({
        [path]: contents,
        [`${project}/deno.json`]: '{}',
        '/tmp/node_modules/@setu-ts/kernel/package.json': '{}',
      });
      expect(await denoInstallRefusal(fs, project), `${contents} at ${project}`).toContain(
        'deno install',
      );
    }
  });

  // PR #450 review: `joinPath` joins with `/` while a native Windows path keeps
  // backslashes, so a listed member must match across the two separators.
  it('recognises a listed member on a native Windows path', async () => {
    const fs = createFakeFs({ 'C:\\ws/setu.workspace.json': workspace('api') });
    expect(await installSearchDirs(fs, 'C:\\ws\\apps\\api')).toEqual([
      'C:\\ws\\apps\\api',
      'C:\\ws\\apps',
      'C:\\ws',
    ]);
  });

  it('refuses an uninstalled Deno project, naming deno install', async () => {
    const fs = createFakeFs({
      '/app/deno.jsonc': '{ "imports": { "@setu-ts/kernel": "npm:@setu-ts/kernel@^0.9.0" } }',
    });
    const refusal = await denoInstallRefusal(fs, '/app');
    expect(refusal).toContain('deno install');
    expect(refusal).not.toContain('upgrading');
  });

  it('refuses a JSR-pinned project, naming the upgrade guide', async () => {
    const fs = createFakeFs({
      '/app/deno.json': '{ "imports": { "@setu-ts/kernel": "jsr:@setu-ts/kernel@^0.8.0" } }',
    });
    const refusal = await denoInstallRefusal(fs, '/app');
    expect(refusal).toContain('docs/upgrading.md');
    expect(refusal).not.toContain('deno install');
  });
});

describe('parentDir', () => {
  it('walks POSIX parents to the root and stops there', () => {
    expect(parentDir('/ws/apps/api')).toBe('/ws/apps');
    expect(parentDir('/ws/apps/api/')).toBe('/ws/apps');
    expect(parentDir('/ws')).toBe('/');
    expect(parentDir('/')).toBeUndefined();
  });

  it('walks Windows parents, never a path prefix', () => {
    // Cutting at the last `/` alone made `C:\\repo\\apps\\ap` the next probe.
    expect(parentDir('C:\\repo\\apps\\api')).toBe('C:\\repo\\apps');
    expect(parentDir('C:\\repo')).toBe('C:\\');
    expect(parentDir('C:\\')).toBeUndefined();
    expect(parentDir('C:')).toBeUndefined();
  });

  it('stops at a UNC share root', () => {
    expect(parentDir('\\\\server\\share\\app')).toBe('\\\\server\\share');
    expect(parentDir('\\\\server\\share')).toBeUndefined();
  });

  it('answers undefined for a relative name with no separator', () => {
    expect(parentDir('app')).toBeUndefined();
  });
});
