import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

/**
 * `@setu-ts/testing`'s `overrideCapability` refuses the capabilities the kernel
 * registers with `{ multi: true }`, because `ServiceRegistry.getAll` returns the
 * single and multi registrations CONCATENATED — so an override of one adds a
 * provider rather than replacing the existing ones, and every real provider
 * keeps running while the caller is told the capability was overridden.
 *
 * That refusal is a hardcoded list, because `IServiceRegistry` exposes no
 * non-instantiating way to ask whether a token is multi-registered: `has()`
 * consults both maps, and `get`/`getAll` both resolve a `registerFactory`
 * registration, so probing with either would construct the very service the
 * caller is replacing.
 *
 * A hardcoded list drifts. This gate reads the kernel's own `{ multi: true }`
 * registration sites and fails when one is missing from the refusal list — the
 * alternative being that a sixth multi capability silently reacquires the
 * add-a-provider path the refusal exists to close.
 */
describe('multi-provider token drift gate', () => {
  it('every kernel { multi: true } registration is refused by overrideCapability', async () => {
    const application = await Deno.readTextFile(
      'packages/kernel/src/application/application.ts',
    );
    const overrideSource = await Deno.readTextFile(
      'packages/testing/src/override-capability.ts',
    );

    // Each site reads `registry.register(CAPABILITIES.X, …, { multi: true })`.
    // Capture the token of every call whose options ENABLE multi — matching on
    // an options object whose sole property is `multi: true` would let a future
    // `{ multi: true, override: true }` escape the gate this test exists to be.
    const kernelTokens = new Set<string>();
    for (
      const match of application.matchAll(
        /registry\.register\(\s*CAPABILITIES\.([A-Z_]+)[\s\S]*?\{[^{}]*\bmulti:\s*true\b[^{}]*\}/g,
      )
    ) {
      kernelTokens.add(match[1] as string);
    }

    // Vacuity guard: the regex must actually find the known sites, or this test
    // passes by matching nothing.
    expect(kernelTokens.size).toBeGreaterThanOrEqual(5);

    const refused = new Set(
      [...overrideSource.matchAll(/CAPABILITIES\.([A-Z_]+),/g)].map((m) => m[1] as string),
    );

    const missing = [...kernelTokens].filter((token) => !refused.has(token)).sort();
    expect(missing).toEqual([]);
  });
});
