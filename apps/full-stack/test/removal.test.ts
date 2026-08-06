/**
 * The removal claim, made executable.
 *
 * What distinguishes this application from one produced by `create-react-router`
 * is not what it adds — it is what it does NOT contain. A conventional React
 * Router app grows a `lib/session.server.ts`, `lib/csrf.server.ts`,
 * `lib/sse.server.ts`, `lib/kv.server.ts` and `lib/service-logger.server.ts`,
 * each a hand-rolled version of a capability this framework already ships, plus
 * a `config/services.server.ts` holding module-level caches of clients.
 *
 * Here those concerns belong to the session, SSE, cache and logger plugins,
 * reached through the service registry the SSR plugin puts on every request.
 * `config/services.server.ts` still exists — a typed accessor is genuinely app
 * code — but it holds NO state, because the kernel's registry is the cache.
 * That distinction is the whole claim, so it is asserted rather than asserted
 * in a comment.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

const APP_ROOT = new URL('../app/', import.meta.url);

/** Modules a conventional React Router app hand-rolls, which plugins replace. */
const REPLACED_BY_CAPABILITIES: readonly string[] = [
  'lib/session.server.ts',
  'lib/csrf.server.ts',
  'lib/sse.server.ts',
  'lib/kv.server.ts',
  'lib/service-logger.server.ts',
];

/** Reports whether a path exists under `app/`. */
async function exists(relativePath: string): Promise<boolean> {
  try {
    await Deno.stat(new URL(relativePath, APP_ROOT));
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

describe('the full-stack example', () => {
  it('hand-rolls none of the modules a capability already provides', async () => {
    for (const module of REPLACED_BY_CAPABILITIES) {
      expect(
        await exists(module),
        `app/${module} exists — that concern belongs to a plugin, not to app code`,
      ).toBe(false);
    }
  });

  it('keeps no module-level cache in its service accessors', async () => {
    const source = await Deno.readTextFile(
      new URL('config/services.server.ts', APP_ROOT),
    );

    // Column zero only: an indented `let` inside a function body is ordinary
    // local state, while one at the top level is process-lifetime state that
    // outlives the request — which is exactly the cache the kernel's service
    // registry replaces.
    //
    // The optional `export` prefix is load-bearing. Matching only the bare
    // `const …` form let `export const clientCache = new Map()` — the same
    // defect with a keyword in front — pass this test unnoticed.
    const TOP_LEVEL = /^(?:export\s+)?(?:let|var|const)\s/;
    const MUTABLE_BINDING = /^(?:export\s+)?(?:let|var)\s/;
    const CACHE_CONSTRUCTOR = /new\s+(?:Map|Set|WeakMap|WeakSet)\b/;

    const cached = source.split('\n').filter((line) =>
      TOP_LEVEL.test(line) &&
      (MUTABLE_BINDING.test(line) || CACHE_CONSTRUCTOR.test(line))
    );

    expect(cached, `module-level state found: ${cached.join(' | ')}`).toEqual(
      [],
    );
  });

  it('reads every context key it sets', async () => {
    // A key set in populateLoadContext but never read is dead surface; a key
    // read but never set silently returns its default and renders an empty
    // page. Both directions are checked, because neither type-checks.
    const keys = await Deno.readTextFile(
      new URL('lib/context-keys.server.ts', APP_ROOT),
    );
    const accessors = await Deno.readTextFile(
      new URL('config/services.server.ts', APP_ROOT),
    );
    const config = await Deno.readTextFile(
      new URL('../honoe.config.ts', import.meta.url),
    );

    const exported = [...keys.matchAll(/export const (\w+Context)\b/g)].map((
      match,
    ) => match[1]);
    expect(exported.length).toBeGreaterThan(0);

    for (const key of exported) {
      // Whitespace-tolerant: `deno fmt` wraps a long `context.set(...)` call
      // across lines, and the test must assert the wiring, not the formatting.
      const isSet = new RegExp(String.raw`context\.set\(\s*${key}\b`).test(
        config,
      );
      expect(isSet, `${key} is never set in honoe.config.ts`).toBe(true);
      // `accessors.includes(key)` would be satisfied by the import statement
      // alone, so a key imported and never read would pass while the message
      // claimed otherwise. Assert the access shape the accessors actually use.
      const isRead = new RegExp(String.raw`context\.get\(\s*${key}\b`).test(
        accessors,
      );
      expect(isRead, `${key} is never read through context.get()`).toBe(true);
    }
  });

  it('creates context keys through contextKeyFor, never as object literals', async () => {
    // Nothing type-checks this. The module exists twice at runtime — Vite
    // inlines a copy into the server build while the kernel loads the other
    // from source — so a `{ defaultValue }` literal produces two distinct key
    // objects, every read falls back to its default, and the page renders
    // empty with no error anywhere.
    const source = await Deno.readTextFile(
      new URL('lib/context-keys.server.ts', APP_ROOT),
    );

    expect(source).toContain('contextKeyFor');
    expect(source).not.toMatch(/=\s*\{\s*defaultValue/);
  });
});
