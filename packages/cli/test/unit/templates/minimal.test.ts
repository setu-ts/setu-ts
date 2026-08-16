/**
 * Tests for the no-template host.
 *
 * The point of this host is that a project with NO decorators and NO container
 * still gets its generated artifacts wired. `setu generate route` is the only
 * HTTP handler such a project can produce, and before M61 it landed unwired —
 * the schematic wrote the barrel and the generated `setu.config.ts` never
 * imported it.
 *
 * The seam list is DERIVED from `seamsFor`, so these assertions are also the
 * guard against the opposite failure: a barrel whose backing plugin this host
 * does not register would put an unresolvable import in the generated config.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { MINIMAL_HOST, MINIMAL_SEAMS } from '../../../src/templates/minimal.ts';
import { REGISTER_ROUTES_EXPORT } from '../../../src/seams/http.ts';
import { GENERATED_MIDDLEWARE_EXPORT } from '../../../src/seams/middleware.ts';
import { GENERATED_PLUGINS_EXPORT } from '../../../src/seams/plugins.ts';

describe('MINIMAL_SEAMS', () => {
  it('is exactly the four families that need no plugin', () => {
    // `controller` joined this list in M70h/E8, in its functional shape: it is
    // no longer gated, so a bare project can generate one. It shares the
    // `route` barrel rather than adding a fourth.
    expect(MINIMAL_SEAMS.map((spec) => spec.schematic).sort())
      .toEqual(['controller', 'middleware', 'plugin', 'route']);
  });

  it('selects the FUNCTIONAL HTTP shapes, never the decorated ones', () => {
    const http = MINIMAL_SEAMS.filter((spec) => spec.barrel === 'src/controllers/index.ts');
    expect(http.length).toBe(2);
    for (const spec of http) {
      // The class-based specs export APP_CONTROLLERS; the functional ones must
      // not, or the generated config would spread a symbol nothing declares.
      expect(spec.exports).toEqual(['registerGeneratedRoutes']);
    }
  });

  // M60 declined this host reasoning that "six of the ten seams would be
  // inert". They are not selected at all — `seamsFor` filters them out — which
  // is the premise that makes this host possible without a fourth template.
  it('selects no seam that declares a required plugin', () => {
    for (const spec of MINIMAL_SEAMS) {
      expect(spec.requiresPlugin).toBeUndefined();
    }
  });
});

describe('MINIMAL_HOST', () => {
  it('registers the runtime provider alone', () => {
    expect(MINIMAL_HOST.plugins.map((w) => w.symbol)).toEqual(['RuntimePlugin']);
  });

  it('adds no middleware — errorHandler belongs to the templates', () => {
    // `@setu-ts/exceptions` is not a dependency of a minimal project, so
    // emitting its middleware would name a package the manifest omits.
    expect(MINIMAL_HOST.middleware).toEqual([]);
  });

  it('composes no starter factory', () => {
    expect(MINIMAL_HOST.appFactory).toBeUndefined();
  });

  it('emits one barrel per selected seam, and no other file', () => {
    expect((MINIMAL_HOST.files ?? []).map((f) => f.path).sort()).toEqual([
      // One HTTP barrel, not two: since M70h `controller` and `route` share
      // `src/controllers/`, so a bare project has exactly one directory that
      // answers requests (E8).
      'src/controllers/index.ts',
      'src/middleware/index.ts',
      'src/plugins/index.ts',
    ]);
  });

  it('imports every barrel it emits', () => {
    const emitted = new Set((MINIMAL_HOST.files ?? []).map((f) => f.path));
    const imported = (MINIMAL_HOST.localImports ?? []).map((l) => l.from.replace(/^\.\//, ''));
    expect(imported.length).toBe(emitted.size);
    for (const from of imported) expect(emitted.has(from)).toBe(true);
  });

  it('registers the HTTP seam through a call inside createApp()', () => {
    expect(MINIMAL_HOST.setupCalls).toContain(`${REGISTER_ROUTES_EXPORT}(app.router);`);
  });

  it('registers the middleware seam through the priority-preserving loop', () => {
    expect((MINIMAL_HOST.setupCalls ?? []).join('\n'))
      .toContain(`for (const generated of ${GENERATED_MIDDLEWARE_EXPORT}) {`);
  });

  it('spreads the generated plugins into the plugin array', () => {
    expect(MINIMAL_HOST.pluginSpreads).toEqual([`...${GENERATED_PLUGINS_EXPORT}`]);
  });

  it('carries no barrel for a gated family', () => {
    const paths = (MINIMAL_HOST.files ?? []).map((f) => f.path);
    for (
      const gated of [
        'src/services/index.ts',
        'src/cqrs/index.ts',
        'src/events/index.ts',
        'src/health/index.ts',
        'src/metrics/index.ts',
      ]
    ) {
      expect(paths).not.toContain(gated);
    }
  });
});
