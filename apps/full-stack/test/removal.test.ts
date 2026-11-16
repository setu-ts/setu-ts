/**
 * The removal claim, made executable.
 *
 * What distinguishes this application from one produced by `create-react-router`
 * is not what it adds — it is what it does NOT contain. A conventional React
 * Router app grows a `lib/session.server.ts`, `lib/csrf.server.ts`,
 * `lib/sse.server.ts`, `lib/kv.server.ts` and `lib/service-logger.server.ts`,
 * each a hand-rolled version of a capability this framework already ships.
 *
 * Here those concerns belong to the session, SSE, cache and logger plugins,
 * reached through the service registry the SSR plugin puts on every request.
 * `server/session.server.ts` provides stateless access to session, CSRF and
 * signed-in-user values; business services live in kernel modules and pages use getService.
 */
import { readFile, stat } from 'node:fs/promises';
import { isNotFound } from '../../../scripts/lib/run.ts';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

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
    await stat(new URL(relativePath, APP_ROOT));
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

describe('the full-stack example', () => {
  it('hand-rolls none of the modules a capability already provides', async () => {
    for (const module of REPLACED_BY_CAPABILITIES) {
      assert.equal(
        await exists(module),
        false,
        `app/${module} exists — that concern belongs to a plugin, not to app code`,
      );
    }
  });

  it('keeps no module-level cache in its session accessors', async () => {
    const source = await readFile(new URL('server/session.server.ts', APP_ROOT), 'utf8');

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

    const cached = source
      .split('\n')
      .filter(
        (line) =>
          TOP_LEVEL.test(line) && (MUTABLE_BINDING.test(line) || CACHE_CONSTRUCTOR.test(line)),
      );

    assert.deepEqual(cached, [], `module-level state found: ${cached.join(' | ')}`);
  });

  it('sets every context key it reads, and reads every key it sets', async () => {
    // A key set but never read is dead surface; a key read but never set
    // silently returns its default and renders an empty page. Both directions
    // are checked, because neither type-checks. `setu.config.ts` sets the
    // request values; the `requireUser` route middleware sets the signed-in user.
    const keys = await readFile(new URL('server/context-keys.server.ts', APP_ROOT), 'utf8');
    const sources = await Promise.all(
      [
        '../setu.config.ts',
        'server/require-user.server.ts',
        'server/session.server.ts',
        'entry.server.tsx',
      ].map((path) => readFile(new URL(path, APP_ROOT), 'utf8')),
    );
    const all = sources.join('\n');

    const exported = [...keys.matchAll(/export const (\w+Context)\b/g)].map((match) => match[1]);
    assert.deepEqual(exported.sort(), [
      'csrfContext',
      'currentUserContext',
      'requestIdContext',
      'sessionContext',
    ]);

    for (const key of exported) {
      // Whitespace-tolerant: Prettier wraps a long `context.set(...)` call
      // across lines, and the test must assert the wiring, not the formatting.
      // `includes(key)` would be satisfied by the import statement alone, so
      // assert the access shape instead.
      assert.ok(new RegExp(String.raw`context\.set\(\s*${key}\b`).test(all), `${key} is never set`);
      assert.ok(
        new RegExp(String.raw`context\.get\(\s*${key}\b`).test(all),
        `${key} is never read through context.get()`,
      );
    }
  });

  it('creates context keys through contextKeyFor, never as object literals', async () => {
    // Nothing type-checks this. The module exists twice at runtime — Vite
    // inlines a copy into the server build while the kernel loads the other
    // from source — so a `{ defaultValue }` literal produces two distinct key
    // objects, every read falls back to its default, and the page renders
    // empty with no error anywhere.
    const source = await readFile(new URL('server/context-keys.server.ts', APP_ROOT), 'utf8');

    assert.ok(source.includes('contextKeyFor'));
    assert.doesNotMatch(source, /=\s*\{\s*defaultValue/);
  });

  it('keeps business modules outside the page tree', async () => {
    for (const directory of ['features', 'services', 'models', 'config']) {
      assert.equal(
        await exists(directory),
        false,
        `app/${directory} must move into kernel modules`,
      );
    }
  });
});
