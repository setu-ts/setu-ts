import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createFakeFs } from '../fixtures/fake-fs.ts';
import { createFakeApp } from '../fixtures/fake-app.ts';
import { configModuleExists, configModulePath, loadApp } from '../../src/app-loader.ts';

describe('configModulePath', () => {
  it('defaults to honoe.config.ts at the project root', () => {
    expect(configModulePath('/app')).toBe('/app/honoe.config.ts');
  });

  it('treats an empty --config as absent', () => {
    expect(configModulePath('/app', '')).toBe('/app/honoe.config.ts');
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
    const fs = createFakeFs({ '/app/honoe.config.ts': 'export function createApp() {}' });
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
    const loaded = await loadApp(
      '/app',
      undefined,
      () => Promise.resolve({ createApp: () => app }),
    );
    expect(loaded).toBe(app);
  });

  it('awaits an async factory', async () => {
    const loaded = await loadApp(
      '/app',
      undefined,
      () => Promise.resolve({ createApp: () => Promise.resolve(app) }),
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
    expect(seen).toBe('file:///app/honoe.config.ts');
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
    await expect(loadApp('/app', undefined, () => Promise.reject(new Error('not found'))))
      .rejects.toThrow('Cannot load file:///app/honoe.config.ts');
  });

  it('preserves the import failure as the cause', async () => {
    const cause = new Error('boom');
    await loadApp('/app', undefined, () => Promise.reject(cause)).catch((error) => {
      expect((error as Error).cause).toBe(cause);
    });
  });

  it('reports a non-Error import rejection', async () => {
    await expect(loadApp('/app', undefined, () => Promise.reject('plain')))
      .rejects.toThrow('plain');
  });

  it('throws naming the expected export when it is missing', async () => {
    await expect(loadApp('/app', undefined, () => Promise.resolve({})))
      .rejects.toThrow("must export a 'createApp' function");
  });

  it('throws when the export is not a function', async () => {
    await expect(loadApp('/app', undefined, () => Promise.resolve({ createApp: 42 })))
      .rejects.toThrow('found number');
  });

  it('throws naming the factory when it rejects', async () => {
    await expect(loadApp('/app', undefined, () =>
      Promise.resolve({
        createApp: () => {
          throw new Error('missing DATABASE_URL');
        },
      }))).rejects.toThrow(
        'createApp() in file:///app/honoe.config.ts threw: missing DATABASE_URL',
      );
  });

  it('reports a non-Error factory throw', async () => {
    await expect(loadApp('/app', undefined, () =>
      Promise.resolve({
        createApp: () => {
          throw 'bare';
        },
      }))).rejects.toThrow('bare');
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
        await expect(loadApp('/app', undefined, () => Promise.resolve({ createApp: () => value })))
          .rejects.toThrow('must return the application from createApplication()');
      });
    }
  });
});
