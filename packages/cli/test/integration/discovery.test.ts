/**
 * The guard C1 exists for: a scaffolded project's factory must survive the
 * REAL discovery path.
 *
 * `setu commands` calls the config factory with its inert discovery env as the
 * FIRST positional argument on every target (`app-loader.ts:180`). A
 * single-parameter `createApp(extra?)` — the shape the M98b README first
 * documented — receives that proxy as `extra` and throws on the spread. The
 * emitted shape puts the devtool composition SECOND, where the proxy is
 * absorbed by the unused `_env`. This file drives both through the real
 * dynamic `import()` and real {@linkcode loadApp} so the collision cannot
 * come back.
 *
 * @module
 */

import { afterEach, beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { loadApp } from '../../src/app-loader.ts';

let root = '';

beforeEach(async () => {
  root = await Deno.makeTempDir({ prefix: 'setu-discovery-' });
});

afterEach(async () => {
  await Deno.remove(root, { recursive: true }).catch(() => {});
});

/** A minimal application-shaped object, sufficient for the loader's checks. */
const APP_BODY = 'return { start() {}, stop() {}, services: {} };';

describe('the discovery loader against the emitted factory shapes', () => {
  it('absorbs the discovery env in the unused first parameter — the emitted shape', async () => {
    // The exact signature the CLI emits (a structural stand-in for the
    // framework composition, which needs no kernel dependency to prove the
    // ARGUMENT POSITIONING this test exists for).
    await Deno.writeTextFile(
      `${root}/setu.config.ts`,
      `export function createApp(
  _env?: Readonly<Record<string, unknown>>,
  devtool?: { plugins?: readonly unknown[]; diagnostics?: unknown },
): unknown {
  void _env;
  void devtool;
  ${APP_BODY}
}
`,
    );
    const app = await loadApp(root);
    expect(typeof app.start).toBe('function');
  });

  it('throws on the single-parameter shape — the collision C1 corrected', async () => {
    // Reproduced, not reasoned: the discovery proxy answers every string key
    // with a truthy inert binding, `extra?.plugins` is therefore a truthy
    // non-iterable, and the spread throws.
    await Deno.writeTextFile(
      `${root}/setu.config.ts`,
      `export function createApp(extra?: { plugins?: readonly string[] }): unknown {
  const app = (() => {
    ${APP_BODY}
  })();
  app.plugins = [...(extra?.plugins ?? [])];
  return app;
}
`,
    );
    await expect(loadApp(root)).rejects.toThrow(/createApp\(\) in .* threw/);
  });

  it('survives the emitted shape with the devtool composition supplied', async () => {
    // `main.dev.ts` passes the composition as the SECOND argument, and the
    // same call works for discovery, which passes only the first.
    await Deno.writeTextFile(
      `${root}/setu.config.ts`,
      `export function createApp(
  _env?: Readonly<Record<string, unknown>>,
  devtool?: { plugins?: readonly unknown[]; diagnostics?: unknown },
): unknown {
  const app = (() => {
    ${APP_BODY}
  })();
  app.plugins = [...(devtool?.plugins ?? [])];
  return app;
}
`,
    );
    const app = await loadApp(root);
    // The loader's contract stops at the application shape; the composition
    // the factory wove is this test's own stand-in.
    expect((app as { plugins?: unknown[] }).plugins).toEqual([]);
  });
});
