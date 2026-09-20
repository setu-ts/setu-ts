/**
 * Test fixture — a minimal plugin providing the fake runtime services, the
 * same composition every kernel integration test uses. The fake's manual
 * clock is reachable through the returned plugin's `tick` so tests can drive
 * monotonic time deterministically.
 *
 * @module
 */
import { CAPABILITIES } from '@setu-ts/common';
import type { IPlugin } from '@setu-ts/common';

import { createFakeRuntime } from './fake-runtime.ts';

/**
 * Creates a plugin that registers {@linkcode createFakeRuntime}'s services.
 *
 * @param env - Environment variables for the fake runtime
 * @returns The plugin, carrying the fake's `tick(ms)` clock control
 */
export function runtimePlugin(
  env: Record<string, string | undefined> = {},
): IPlugin & { tick: (ms: number) => void } {
  const fake = createFakeRuntime({ env });
  return Object.assign(
    {
      name: 'fake-runtime',
      version: '1.0.0',
      provides: [CAPABILITIES.RUNTIME],
      register(ctx) {
        ctx.services.register(CAPABILITIES.RUNTIME, fake.runtime);
      },
    } as IPlugin,
    { tick: fake.tick },
  );
}
