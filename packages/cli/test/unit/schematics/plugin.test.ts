/**
 * Unit tests for the plugin schematic.
 *
 * @module
 */

import { deriveNames } from '../../../src/utils/names.ts';
import { generatePlugin } from '../../../src/schematics/plugin.ts';
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

describe('generatePlugin', () => {
  it('emits a plugin file with correct structure', () => {
    const names = deriveNames('auth');
    const options = { runtime: {} as unknown, plugins: new Set<string>() };
    const files = generatePlugin(names, options);

    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('src/plugins/auth.plugin.ts');
    expect(files[0].contents).toContain('IPlugin');
    expect(files[0].contents).toContain('AuthPlugin');
    expect(files[0].contents).toContain('provides: ["auth"]');
  });

  it('uses the kebab name for the plugin name field', () => {
    const names = deriveNames('cache');
    const options = { runtime: {} as unknown, plugins: new Set<string>() };
    const files = generatePlugin(names, options);

    expect(files[0].contents).toContain('name: "cache-plugin"');
  });

  it('exports the plugin as a constant', () => {
    const names = deriveNames('logger');
    const options = { runtime: {} as unknown, plugins: new Set<string>() };
    const files = generatePlugin(names, options);

    expect(files[0].contents).toContain('export const LoggerPlugin: IPlugin = {');
  });
});
