/**
 * Drives the REAL `npm:@launchdarkly/node-server-sdk` import performed by
 * `loadLaunchDarklyModule`, so the production load path is exercised rather
 * than only the injected module seam.
 *
 * Guarded: when the package cannot be resolved (offline CI, no npm cache) the
 * loader must still fail with a descriptive `LaunchDarklyModuleError` rather
 * than a silent or opaque one — which is itself the assertion.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  LaunchDarklyModuleError,
  loadLaunchDarklyModule,
} from '../../src/providers/launchdarkly-module.ts';

describe('loadLaunchDarklyModule (guarded real import)', () => {
  it('either resolves the real SDK module or fails descriptively', async () => {
    let module: { init: unknown } | undefined;
    let error: Error | undefined;

    try {
      module = await loadLaunchDarklyModule();
    } catch (caught) {
      error = caught instanceof Error ? caught : new Error(String(caught));
    }

    if (module !== undefined) {
      // The real package resolved: `init` must be the synchronous factory the
      // provider calls. This is the fact the whole provider design rests on.
      expect(typeof module.init).toBe('function');
      return;
    }

    expect(error).toBeInstanceOf(LaunchDarklyModuleError);
    expect(error?.message).toContain('@launchdarkly/node-server-sdk');
  });

  it('reports a client built through the real module surface as a client', async () => {
    let module: Awaited<ReturnType<typeof loadLaunchDarklyModule>> | undefined;
    try {
      module = await loadLaunchDarklyModule();
    } catch {
      // Package unavailable — the descriptive-failure path is asserted above.
      return;
    }

    // Build against an offline configuration so no network call is made: the
    // SDK's `init` is synchronous and returns immediately either way.
    const client = module.init('sdk-key-not-used', { offline: true, sendEvents: false });
    try {
      expect(typeof client.initialized).toBe('function');
      expect(typeof client.boolVariation).toBe('function');
      expect(typeof client.allFlagsState).toBe('function');
      expect(typeof client.on).toBe('function');
      expect(typeof client.close).toBe('function');
    } finally {
      client.close();
    }
  });
});
