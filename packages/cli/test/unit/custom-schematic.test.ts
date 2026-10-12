import { describe, expect, it } from 'vitest';
import {
  CUSTOM_SCHEMATIC_DIR,
  customSchematicUrl,
  isCustomSchematicName,
  loadCustomSchematic,
} from '../../src/schematics/custom.ts';
import type { GeneratedFile } from '../../src/utils/file-writer.ts';

describe('customSchematicUrl', () => {
  it('resolves under .setu-ts/schematics', () => {
    expect(customSchematicUrl('/app', 'my-gen'))
      .toBe(`file:///app/${CUSTOM_SCHEMATIC_DIR}/my-gen.ts`);
  });

  it('produces an absolute file URL from a relative directory', () => {
    expect(customSchematicUrl('project', 'gen'))
      .toBe(`file:///project/${CUSTOM_SCHEMATIC_DIR}/gen.ts`);
  });
});

// M111d audit F1: a schematic name is one file name. A separator, a dot
// segment or a percent escape would reach — and execute — a module outside
// the project's schematics directory, since the URL builder normalises `..`.
describe('isCustomSchematicName', () => {
  const cases: readonly (readonly [string, boolean])[] = [
    ['my-gen', true],
    ['gen_2', true],
    ['Gen', true],
    ['../../../evil', false],
    ['%2e%2e/%2e%2e/evil', false],
    ['a/b', false],
    ['a\\b', false],
    ['.hidden', false],
    ['-flag', false],
    ['a.ts', false],
    ['', false],
  ];
  for (const [name, valid] of cases) {
    it(`${valid ? 'accepts' : 'refuses'} ${JSON.stringify(name)}`, () => {
      expect(isCustomSchematicName(name)).toBe(valid);
    });
  }
});

describe('loadCustomSchematic', () => {
  it('refuses a path-like name before importing anything', async () => {
    const urls: string[] = [];
    await expect(
      loadCustomSchematic('/app', '../../../evil', (url) => {
        urls.push(url);
        return Promise.resolve({});
      }),
    ).rejects.toThrow('Invalid custom schematic name');
    expect(urls).toEqual([]);
  });

  const schematic = (): readonly GeneratedFile[] => [{ path: 'a.txt', contents: 'A' }];

  it('returns the schematic named export', async () => {
    const loaded = await loadCustomSchematic('/app', 'ok', () => Promise.resolve({ schematic }));
    expect(loaded).toBe(schematic);
  });

  it('falls back to the default export', async () => {
    const loaded = await loadCustomSchematic(
      '/app',
      'ok',
      () => Promise.resolve({ default: schematic }),
    );
    expect(loaded).toBe(schematic);
  });

  it('prefers the named export over the default', async () => {
    const other = () => [];
    const loaded = await loadCustomSchematic(
      '/app',
      'ok',
      () => Promise.resolve({ schematic, default: other }),
    );
    expect(loaded).toBe(schematic);
  });

  it('passes the resolved URL to the loader', async () => {
    let seen: string | undefined;
    await loadCustomSchematic('/app', 'probe', (url) => {
      seen = url;
      return Promise.resolve({ schematic });
    });
    expect(seen).toBe(`file:///app/${CUSTOM_SCHEMATIC_DIR}/probe.ts`);
  });

  it('throws naming the path when the module cannot be imported', async () => {
    await expect(
      loadCustomSchematic('/app', 'missing', () => Promise.reject(new Error('not found'))),
    ).rejects.toThrow(`file:///app/${CUSTOM_SCHEMATIC_DIR}/missing.ts`);
  });

  it('preserves the underlying failure as the cause', async () => {
    const cause = new Error('not found');
    await loadCustomSchematic('/app', 'missing', () => Promise.reject(cause)).catch((error) => {
      expect((error as Error).cause).toBe(cause);
    });
  });

  it('reports a non-Error rejection', async () => {
    await expect(
      loadCustomSchematic('/app', 'missing', () => Promise.reject('plain string')),
    ).rejects.toThrow('plain string');
  });

  it('throws naming the expected export when the module has none', async () => {
    await expect(
      loadCustomSchematic('/app', 'bad', () => Promise.resolve({})),
    ).rejects.toThrow("must export a 'schematic' function");
  });

  it('throws when the export is not a function', async () => {
    await expect(
      loadCustomSchematic('/app', 'bad', () => Promise.resolve({ schematic: 'nope' })),
    ).rejects.toThrow('found string');
  });
});
