/**
 * Tests for the `full-stack` template definition and the files it emits.
 *
 * The load-bearing assertion here is a NEGATIVE one. The skeleton is adapted
 * from a real React Router application whose `lib/` holds session, CSRF, SSE,
 * key-vault and logger modules; every one of those is a capability this
 * framework already ships, and reimplementing them in app code is the failure
 * this template exists to prevent. So the emitted path set is pinned against
 * their reappearance, not only against the layering being present.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type { TargetRuntime } from '../../src/constants.ts';
import { FULL_STACK_TEMPLATE } from '../../src/templates/full-stack.ts';
import { FULL_STACK_APP_FILES } from '../../src/templates/full-stack-app-files.ts';
import {
  FULL_STACK_NPM_DEPENDENCIES,
  FULL_STACK_NPM_DEV_DEPENDENCIES,
  FULL_STACK_TSCONFIG_OPTIONS,
} from '../../src/templates/full-stack-build-files.ts';
import { FULL_STACK_APP_FRAMEWORK_PACKAGES } from '../../src/templates/full-stack.ts';
import { getTemplate } from '../../src/templates/registry.ts';

/** Every path the template emits. */
const paths = (FULL_STACK_TEMPLATE.files ?? []).map((file) => file.path);

/** Reads one emitted file's contents by path. */
function contentsOf(path: string): string {
  const file = (FULL_STACK_TEMPLATE.files ?? []).find((candidate) => candidate.path === path);
  if (file === undefined) throw new Error(`Template emits no ${path}`);
  return file.contents;
}

describe('full-stack template | registration', () => {
  it('is reachable by name', () => {
    expect(getTemplate('full-stack')).toBe(FULL_STACK_TEMPLATE);
  });

  it('composes through the starter factory rather than a plugin list', () => {
    expect(FULL_STACK_TEMPLATE.plugins).toEqual([]);
    expect(FULL_STACK_TEMPLATE.appFactory?.symbol).toBe('createFullStackAppFromConfig');
    expect(FULL_STACK_TEMPLATE.appFactory?.pkg).toBe('full-stack-starter');
  });

  it('adds no middleware, because the starter already adds the error handler', () => {
    // A second errorHandler at a different priority would be the outermost one,
    // silently displacing the starter's.
    expect(FULL_STACK_TEMPLATE.middleware).toEqual([]);
  });

  it('refuses no runtime target', () => {
    expect(FULL_STACK_TEMPLATE.unsupported).toEqual({});
  });
});

describe('full-stack template | the layering it emits', () => {
  it('emits the route, feature, service, model and lib layers', () => {
    expect(paths).toContain('app/routes.ts');
    expect(paths).toContain('app/root.tsx');
    expect(paths).toContain('app/features/products/products.server.ts');
    expect(paths).toContain('app/services/products.server.ts');
    expect(paths).toContain('app/models/product.ts');
    expect(paths).toContain('app/lib/context-keys.server.ts');
    expect(paths).toContain('app/lib/load-context.ts');
    expect(paths).toContain('app/config/services.server.ts');
  });

  it('emits both layout groups and a route in each', () => {
    expect(paths).toContain('app/components/layouts/AppLayout.tsx');
    expect(paths).toContain('app/components/layouts/LoginLayout.tsx');
    expect(paths.some((path) => path.startsWith('app/routes/_app/'))).toBe(true);
    expect(paths.some((path) => path.startsWith('app/routes/_auth/'))).toBe(true);
  });

  it('wires each layout group through flatRoutes in routes.ts', () => {
    const routes = contentsOf('app/routes.ts');

    expect(routes).toContain("flatRoutes({ rootDirectory: 'routes/_auth' })");
    expect(routes).toContain("flatRoutes({ rootDirectory: 'routes/_app' })");
    // Emitted layouts that no route config references would be dead files.
    expect(routes).toContain("layout('./components/layouts/LoginLayout.tsx'");
    expect(routes).toContain("layout('./components/layouts/AppLayout.tsx'");
  });

  it('emits no duplicate paths', () => {
    expect(new Set(paths).size).toBe(paths.length);
  });
});

describe('full-stack template | what the plugins own is NOT reimplemented', () => {
  // Each entry names the module a conventional React Router app grows and the
  // capability that replaces it. If one reappears here, the skeleton has
  // started shipping a second copy of the framework.
  const owned = [
    'app/lib/session.server.ts',
    'app/lib/cookie-attrs.server.ts',
    'app/lib/csrf.server.ts',
    'app/lib/sse.server.ts',
    'app/lib/kv.server.ts',
    'app/lib/service-logger.server.ts',
    'app/lib/route-guards.server.ts',
    'app/lib/http/xior.server.ts',
    'app/lib/appinsights-bootstrap.server.ts',
  ];

  for (const path of owned) {
    it(`does not emit ${path}`, () => {
      expect(paths).not.toContain(path);
    });
  }

  it('keeps the service accessor stateless, with no module-level cache', () => {
    const services = contentsOf('app/config/services.server.ts');

    // The module it replaces exists to memoise clients and secret lookups per
    // process — which is what the kernel's service registry already is.
    expect(services).not.toContain('new Map');
    expect(services).toContain('loggerContext');
    expect(services).toContain('secretsContext');
  });

  it('imports framework VALUES only from server-only modules', () => {
    // The client bundle inlines what it imports and cannot resolve a JSR
    // specifier, so a framework value import outside a `.server.ts` module
    // fails the build outright. Server-only modules may import them, because
    // the server build treats framework packages as external — which is also
    // what keeps context keys identical across that boundary. Type imports are
    // erased and are fine anywhere.
    for (const file of FULL_STACK_APP_FILES) {
      if (file.path.endsWith('.server.ts')) continue;

      for (
        const match of file.contents.matchAll(
          /^import\s+(?!type\b)[^;]*?from\s+'(@hono-enterprise\/[^']+)'/gm,
        )
      ) {
        throw new Error(
          `${file.path} value-imports ${match[1]}; only .server.ts modules may do that`,
        );
      }
    }
  });

  it('keeps the context keys in a server-only module', () => {
    // They value-import the key helper, so a client-reachable module declaring
    // them would break the client build.
    expect(paths).toContain('app/lib/context-keys.server.ts');
    expect(paths).not.toContain('app/lib/context-keys.ts');
  });

  it('builds every key through contextKeyFor, never a literal', () => {
    const keys = contentsOf('app/lib/context-keys.server.ts');

    // A `{ defaultValue }` literal is the defect: Vite inlines this module into
    // the server build while the runtime loads honoe.config.ts from source, so
    // two literals would look identical and match nothing.
    expect(keys).toContain('contextKeyFor');
    expect(keys).not.toContain('defaultValue:');
  });

  it('declares the session keys in app code, not in a plugin', () => {
    const keys = contentsOf('app/lib/context-keys.server.ts');

    expect(keys).toContain('sessionContext');
    expect(keys).toContain('csrfContext');
    // Nothing here imports react-router: the key helper comes from the SSR
    // plugin, which is what keeps app code free of the router on the server.
    expect(keys).not.toContain("from 'react-router'");
  });
});

describe('full-stack template | the runtime-dependent argument', () => {
  const argsFor = (runtime: TargetRuntime): string =>
    FULL_STACK_TEMPLATE.appFactory?.args?.(runtime) ?? '';

  it('serves assets from the client build on Deno, Node and Bun', () => {
    for (const runtime of ['deno', 'node', 'bun'] as const) {
      expect(argsFor(runtime)).toContain("assetsDir: './build/client/assets'");
    }
  });

  it('omits the asset option on Cloudflare Workers', () => {
    // No filesystem there: the asset handler would answer 404 for every asset,
    // so the route is not registered and the platform binding serves them.
    expect(argsFor('cloudflare-workers')).not.toContain('assetsDir');
  });

  it('bridges the session and CSRF token into the load context on every target', () => {
    for (const runtime of ['deno', 'node', 'bun', 'cloudflare-workers'] as const) {
      const args = argsFor(runtime);
      expect(args).toContain('populateLoadContext');
      expect(args).toContain('context.set(sessionContext, getSession(ctx))');
      expect(args).toContain('context.set(csrfContext, getCsrfToken(ctx))');
      expect(args).toContain("new URL('./build/server/index.js', import.meta.url).href");
    }
  });

  it('imports every identifier its argument string names', () => {
    const args = argsFor('deno');
    const localSymbols = (FULL_STACK_TEMPLATE.localImports ?? []).flatMap((i) => i.symbols);
    const packageSymbols = (FULL_STACK_TEMPLATE.packageImports ?? []).flatMap((i) =>
      i.symbols ?? []
    );
    const inScope = new Set([...localSymbols, ...packageSymbols]);

    for (const symbol of ['sessionContext', 'csrfContext', 'getSession', 'getCsrfToken']) {
      expect(args).toContain(symbol);
      expect(inScope.has(symbol)).toBe(true);
    }
  });
});

describe('full-stack template | manifest contributions', () => {
  it('declares the alias every emitted module imports through', () => {
    expect(FULL_STACK_TSCONFIG_OPTIONS['paths']).toEqual({ '~/*': ['./app/*'] });
    expect(FULL_STACK_TEMPLATE.manifest?.denoImports).toEqual({ '~/': './app/' });
  });

  it('carries the frontend build toolchain as dev dependencies', () => {
    expect(FULL_STACK_NPM_DEV_DEPENDENCIES['vite']).toBeDefined();
    expect(FULL_STACK_NPM_DEV_DEPENDENCIES['@react-router/dev']).toBeDefined();
    expect(FULL_STACK_NPM_DEV_DEPENDENCIES['@react-router/fs-routes']).toBeDefined();
  });

  it('pins React Router to the major the SSR plugin loads', () => {
    // The plugin does `await import('npm:react-router@8')` and hands it this
    // project's server build; a v7 build against a v8 runtime installs cleanly
    // and then fails at request time.
    expect(FULL_STACK_NPM_DEPENDENCIES['react-router']).toBe('^8.0.0');
    expect(FULL_STACK_NPM_DEV_DEPENDENCIES['react-router']).toBe('^8.0.0');
    expect(FULL_STACK_NPM_DEV_DEPENDENCIES['@react-router/dev']).toBe('^8.0.0');
  });

  it('asks for the read permission the SSR plugin needs on Deno', () => {
    expect(FULL_STACK_TEMPLATE.manifest?.denoPermissions).toEqual(['--allow-read']);
  });

  it('declares the packages its emitted files import', () => {
    const packages = (FULL_STACK_TEMPLATE.packageImports ?? []).map((entry) => entry.pkg);

    // Named by honoe.config.ts's bridge, and by app/lib/context-keys.ts.
    expect(packages).toContain('session-plugin');
    expect(packages).toContain('react-router-plugin');
  });

  it('emits the build files the React Router toolchain needs', () => {
    expect(paths).toContain('react-router.config.ts');
    expect(paths).toContain('vite.config.ts');
  });

  it('externalises every framework package the app imports, and pins each one', () => {
    // The two must agree. Bundled instead of externalised, a package gets a
    // second copy in the server build and its context keys stop matching the
    // ones honoe.config.ts holds — which fails silently, as a context value
    // that is always its default.
    const vite = contentsOf('vite.config.ts');
    const pinned = (FULL_STACK_TEMPLATE.packageImports ?? []).map((entry) => entry.pkg);

    for (const pkg of FULL_STACK_APP_FRAMEWORK_PACKAGES) {
      expect(vite).toContain(`'@hono-enterprise/${pkg}'`);
      expect(pinned).toContain(pkg);
    }
  });

  it('declares the externals under the ssr environment build', () => {
    // Verified against the real toolchain: React Router builds through Vite's
    // Environment API, and neither a top-level `ssr.external` nor
    // `environments.ssr.resolve.external` reaches that build.
    const vite = contentsOf('vite.config.ts');

    expect(vite).toContain('environments');
    expect(vite).toContain('rollupOptions');
    expect(vite).toContain('external: frameworkPackages');
  });
});

describe('full-stack app files | module-level shape', () => {
  it('marks every server-only module with the .server convention', () => {
    const serverModules = FULL_STACK_APP_FILES
      .filter((file) => file.contents.includes('@hono-enterprise/common'))
      .map((file) => file.path);

    // context-keys.ts is the one exception: it is a type-only import of a key
    // shape, imported by both server and client code.
    for (const path of serverModules) {
      expect(path.endsWith('.server.ts') || path === 'app/lib/context-keys.ts').toBe(true);
    }
  });

  it('keeps the model free of server-only imports', () => {
    const model = contentsOf('app/models/product.ts');

    // Shared by loaders and components, so a server import would break the
    // client bundle.
    expect(model).not.toContain('@hono-enterprise/');
    expect(model).not.toContain('.server.ts');
  });
});
