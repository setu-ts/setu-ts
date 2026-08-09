/**
 * Tests for the `--di` wiring rule.
 *
 * The assertion that matters here is the dedupe. The kernel THROWS
 * `Duplicate plugin name 'di'` at `start()`
 * (`kernel/src/registry/plugin-resolver.ts:106`), so a `withDiPlugin` that
 * appended unconditionally would let `setu new x --template nest --di`
 * scaffold a project that type-checks, passes every file assertion, and then
 * cannot boot — a failure no `deno check` of the generated project can see.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { DI_WIRING, withDiPlugin } from '../../../src/templates/di.ts';
import type { Wiring } from '../../../src/templates/registry.ts';
import { NEST_PLUGINS } from '../../../src/templates/nest.ts';
import { REST_PLUGINS } from '../../../src/templates/rest.ts';

const RUNTIME: Wiring = { pkg: 'runtime', symbol: 'RuntimePlugin' };

describe('DI_WIRING', () => {
  it('names the package and symbol the generated config imports', () => {
    expect(DI_WIRING).toEqual({ pkg: 'di-plugin', symbol: 'DiPlugin' });
  });

  it('carries no args, because the DiPlugin options parameter is optional', () => {
    // `DiPlugin(options?: DiPluginOptions)` — a bare `DiPlugin()` type-checks,
    // so an args string would be text with nothing to say.
    expect(DI_WIRING.args).toBeUndefined();
  });
});

describe('withDiPlugin', () => {
  it('returns the list untouched when --di was not given', () => {
    const wirings = [RUNTIME];
    expect(withDiPlugin(wirings, { di: false })).toBe(wirings);
  });

  it('is a no-op under the default features', () => {
    // Pins that the default is OFF: every template scaffolded without the flag
    // must render byte-identically to before the flag existed.
    expect(withDiPlugin(REST_PLUGINS, { di: false })).toBe(REST_PLUGINS);
  });

  it('appends exactly one wiring when --di was given', () => {
    const result = withDiPlugin([RUNTIME], { di: true });
    expect(result).toEqual([RUNTIME, DI_WIRING]);
  });

  it('appends rather than inserts, so the difference is one trailing entry', () => {
    const result = withDiPlugin(REST_PLUGINS, { di: true });
    expect(result.length).toBe(REST_PLUGINS.length + 1);
    expect(result.slice(0, -1)).toEqual(REST_PLUGINS);
    expect(result[result.length - 1]).toEqual(DI_WIRING);
  });

  // The load-bearing branch: `nest` already registers DiPlugin, and a second
  // registration is a startup throw rather than a duplicate import.
  it('does not append when the list already carries a di-plugin wiring', () => {
    expect(withDiPlugin(NEST_PLUGINS, { di: true })).toBe(NEST_PLUGINS);
  });

  it('recognizes the package rather than the exact wiring object', () => {
    // A template that built its own equivalent wiring must be recognized too —
    // matching on identity would miss it and reintroduce the duplicate.
    const ownWiring: readonly Wiring[] = [
      RUNTIME,
      { pkg: 'di-plugin', symbol: 'DiPlugin', args: "{ defaultScope: 'scoped' }" },
    ];
    expect(withDiPlugin(ownWiring, { di: true })).toBe(ownWiring);
  });
});
