/**
 * Health-indicator names the installed plugins already claim (M70g — register row A1).
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import {
  findPluginIndicatorClaim,
  PLUGIN_HEALTH_INDICATORS,
} from '../../../src/utils/plugin-claims.ts';
import { findNameConflict } from '../../../src/utils/name-conflicts.ts';

describe('findPluginIndicatorClaim', () => {
  it('reports the plugin that claims the name', () => {
    expect(findPluginIndicatorClaim('database', new Set(['database-plugin'])))
      .toBe('database-plugin');
    expect(findPluginIndicatorClaim('static-files', new Set(['static-plugin'])))
      .toBe('static-plugin');
  });

  it('reports nothing when the claiming plugin is not installed', () => {
    // The whole point of reading the detected set: a name is only taken if the
    // plugin that takes it is actually in the project.
    expect(findPluginIndicatorClaim('database', new Set())).toBe(undefined);
    expect(findPluginIndicatorClaim('database', new Set(['cache-plugin']))).toBe(undefined);
  });

  it('reports nothing for a name no plugin claims', () => {
    expect(findPluginIndicatorClaim('billing-schema', new Set(['database-plugin'])))
      .toBe(undefined);
  });

  it('records only kebab-case identifiers, since that is all a name can derive to', () => {
    for (const [pkg, names] of PLUGIN_HEALTH_INDICATORS) {
      expect(pkg.endsWith('-plugin')).toBe(true);
      for (const name of names) expect(name).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });
});

describe('findNameConflict against an installed plugin', () => {
  const empty = { artifacts: {}, modules: [] as readonly string[] };

  it('refuses a health indicator whose name a plugin already registers', () => {
    const conflict = findNameConflict(
      'health-indicator',
      'database',
      new Set(['database-plugin']),
      empty.artifacts,
      empty.modules,
    );

    expect(conflict?.claimedBy).toBe('the installed plugin @setu-ts/database-plugin');
    expect(conflict?.resource).toContain('database');
    // The consequence names the failure the developer would otherwise meet at boot.
    expect(conflict?.consequence).toContain('app.start()');
    expect(conflict?.remedy).toContain('@setu-ts/database-plugin');
  });

  it('allows the name when that plugin is absent', () => {
    expect(
      findNameConflict('health-indicator', 'database', new Set(), empty.artifacts, empty.modules),
    ).toBe(undefined);
  });

  it('does not apply the plugin table to any other schematic', () => {
    // `setu g service cache` is fine in a project with `cache-plugin`: a service
    // token and a health-indicator name are different namespaces.
    expect(
      findNameConflict(
        'service',
        'cache',
        new Set(['cache-plugin']),
        empty.artifacts,
        empty.modules,
      ),
    ).toBe(undefined);
  });
});
