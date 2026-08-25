/**
 * M70n X5-9 — the gated `static` arm of the full-stack starter.
 *
 * Mirrors the `reactRouter` arm's contract exactly: present, the arm registers
 * `StaticPlugin`; absent, the composition is byte-identical to today — no new
 * plugin, no reordering of the existing list.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { buildFullStackPlugins } from '../../src/app.ts';

describe('full-stack-starter static arm', () => {
  // The baseline: no options at all. Every assertion below compares against
  // this list so a future reorder of always-on plugins fails loudly here too.
  const baseline = buildFullStackPlugins().map((plugin) => plugin.name);

  it('registers StaticPlugin when the static arm is present', () => {
    const names = buildFullStackPlugins({ static: { root: './public' } }).map(
      (plugin) => plugin.name,
    );

    expect(names.filter((name) => name === 'static-plugin')).toEqual([
      'static-plugin',
    ]);
  });

  it('adds the arm purely additively, preserving the baseline order', () => {
    const withStatic = buildFullStackPlugins({ static: { root: './public' } })
      .map((plugin) => plugin.name);

    // Removing the arm's plugin reproduces the baseline list byte-for-byte.
    expect(withStatic.filter((name) => name !== 'static-plugin')).toEqual(
      baseline,
    );
  });

  it('omits StaticPlugin when the arm is absent (byte-identical composition)', () => {
    const noArgs = buildFullStackPlugins().map((plugin) => plugin.name);
    const emptyOptions = buildFullStackPlugins({}).map((plugin) => plugin.name);

    expect(emptyOptions).toEqual(noArgs);
    expect(noArgs).toEqual(baseline);
    expect(baseline).not.toContain('static-plugin');
  });
});
