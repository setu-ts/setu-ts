import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { viteDevExternals } from '../../src/dev/vite-dev-externals.ts';
import type {
  ViteHookContext,
  ViteResolvedEnvironments,
} from '../../src/dev/vite-dev-externals.ts';

const SSR: ViteHookContext = { environment: { name: 'ssr' } };
const CLIENT: ViteHookContext = { environment: { name: 'client' } };

const FILE_ROOT = 'file:///work/packages/react-router-plugin/src/';
const resolutions: Record<string, string> = {
  '@setu-ts/common': 'jsr:@setu-ts/common@^0.9.0',
  '@setu-ts/react-router-plugin': `${FILE_ROOT}index.ts`,
  '@setu-ts/react-router-plugin/extra': `${FILE_ROOT}extra.ts`,
  'npm-lib': 'npm:npm-lib@^1.0.0',
};
const resolve = (specifier: string): string => {
  const resolved = resolutions[specifier];
  if (resolved === undefined) throw new Error(`unexpected resolve: ${specifier}`);
  return resolved;
};

function resolvedConfig(builtins: (string | RegExp)[]): ViteResolvedEnvironments {
  return { environments: { ssr: { resolve: { builtins } } } };
}

describe('viteDevExternals', () => {
  const plugin = viteDevExternals({
    packages: ['@setu-ts/common', '@setu-ts/react-router-plugin'],
    resolve,
  });

  it('runs before Vite resolves the import', () => {
    expect(plugin.name).toBe('setu-ts-dev-externals');
    expect(plugin.enforce).toBe('pre');
  });

  it('resolves a listed package with the runtime resolver, external', () => {
    expect(plugin.resolveId.call(SSR, '@setu-ts/common')).toEqual({
      id: 'jsr:@setu-ts/common@^0.9.0',
      external: true,
    });
  });

  it('resolves a subpath of a listed package', () => {
    expect(plugin.resolveId.call(SSR, '@setu-ts/react-router-plugin/extra')).toEqual({
      id: `${FILE_ROOT}extra.ts`,
      external: true,
    });
  });

  it('leaves a client import of a listed package to Vite', () => {
    // A browser cannot import the runtime's jsr:/file: specifier.
    expect(plugin.resolveId.call(CLIENT, '@setu-ts/common')).toBeNull();
    expect(plugin.resolveId.call(CLIENT, '@setu-ts/react-router-plugin/extra')).toBeNull();
  });

  it('leaves an unlisted or prefix-sharing specifier to Vite', () => {
    expect(plugin.resolveId.call(SSR, 'react-router')).toBeNull();
    expect(plugin.resolveId.call(SSR, '@setu-ts/common-extra')).toBeNull();
    expect(plugin.resolveId.call(SSR, '/app/root.tsx')).toBeNull();
  });

  it('appends to the SSR built-ins and keeps the existing ones', () => {
    const nodeBuiltin = /^node:/;
    const config = resolvedConfig(['fs', nodeBuiltin]);
    plugin.configResolved(config);
    const builtins = config.environments['ssr']?.resolve.builtins ?? [];

    expect(builtins.slice(0, 2)).toEqual(['fs', nodeBuiltin]);
    const matches = (id: string): boolean =>
      builtins.some((b) => typeof b === 'string' ? b === id : b.test(id));
    expect(matches('jsr:@setu-ts/common@^0.9.0')).toBe(true);
    expect(matches('npm:npm-lib@^1.0.0')).toBe(true);
    // A file-mapped package matches its entry's directory, so subpaths are covered.
    expect(matches(`${FILE_ROOT}index.ts`)).toBe(true);
    expect(matches(`${FILE_ROOT}extra.ts`)).toBe(true);
    expect(matches('file:///work/app/root.tsx')).toBe(false);
    expect(matches('/work/app/root.tsx')).toBe(false);
  });

  it('escapes regular-expression characters in a file-mapped directory', () => {
    const odd = 'file:///w+rk/(pkg)/src/';
    const p = viteDevExternals({ packages: ['@setu-ts/odd'], resolve: () => `${odd}index.ts` });
    const config = resolvedConfig([]);
    p.configResolved(config);
    const patterns = (config.environments['ssr']?.resolve.builtins ?? []) as RegExp[];
    expect(patterns.some((r) => r.test(`${odd}mod.ts`))).toBe(true);
    expect(patterns.some((r) => r.test('file:///wwrk/pkg/src/mod.ts'))).toBe(false);
  });

  it('does nothing without an SSR environment', () => {
    const config: ViteResolvedEnvironments = { environments: {} };
    plugin.configResolved(config);
    expect(config.environments).toEqual({});
  });
});
