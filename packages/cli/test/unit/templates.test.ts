import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { TARGET_RUNTIMES, TEMPLATES } from '../../src/constants.ts';
import {
  getTemplate,
  listTemplates,
  MINIMAL_PLUGINS,
  packagesOf,
  type Wiring,
} from '../../src/templates/registry.ts';
import { REST_MIDDLEWARE, REST_PLUGINS, REST_TEMPLATE } from '../../src/templates/rest.ts';
import { MICROSERVICE_TEMPLATE } from '../../src/templates/microservice.ts';
import { NEST_TEMPLATE } from '../../src/templates/nest.ts';

const symbols = (wirings: readonly Wiring[]) => wirings.map((w) => w.symbol);

describe('template registry', () => {
  it('registers exactly the templates the --template flag accepts', () => {
    expect(listTemplates().map((t) => t.name)).toEqual([...TEMPLATES]);
  });

  it('exposes every name as a lookup', () => {
    for (const name of TEMPLATES) {
      expect(getTemplate(name)?.name).toBe(name);
    }
  });

  it('returns undefined for an unknown name', () => {
    expect(getTemplate('graphql')).toBeUndefined();
  });

  it('returns undefined for inherited Object properties', () => {
    for (const name of ['constructor', '__proto__', 'toString', 'valueOf']) {
      expect(getTemplate(name)).toBeUndefined();
    }
  });

  it('gives every template a non-empty description for help output', () => {
    for (const template of listTemplates()) {
      expect(template.description.length).toBeGreaterThan(0);
    }
  });
});

describe('MINIMAL_PLUGINS', () => {
  it('is the runtime provider alone', () => {
    expect(symbols(MINIMAL_PLUGINS)).toEqual(['RuntimePlugin']);
  });

  it('registers no middleware', () => {
    // The default scaffold has no error handler; only templates add one.
    expect(MINIMAL_PLUGINS.every((w) => w.pkg !== 'exceptions')).toBe(true);
  });
});

describe('rest template', () => {
  it('registers the documented plugin set in order, runtime first', () => {
    expect(symbols(REST_TEMPLATE.plugins)).toEqual([
      'RuntimePlugin',
      'ConfigPlugin',
      'LoggerPlugin',
      'ValidationPlugin',
      'HttpSecurityPlugin',
      'HealthPlugin',
      'MetricsPlugin',
      'OpenApiPlugin',
      'DecoratorPlugin',
    ]);
  });

  it('adds errorHandler as MIDDLEWARE, never as a plugin', () => {
    // `@hono-enterprise/exceptions` ships a MiddlewareFunction, not an IPlugin.
    expect(symbols(REST_TEMPLATE.middleware)).toEqual(['errorHandler']);
    expect(symbols(REST_TEMPLATE.plugins)).not.toContain('errorHandler');
    expect(REST_TEMPLATE.plugins.every((w) => w.pkg !== 'exceptions')).toBe(true);
  });

  it('excludes plugins that need credentials before they do anything', () => {
    const packages = REST_TEMPLATE.plugins.map((w) => w.pkg);
    expect(packages).not.toContain('database-plugin');
    expect(packages).not.toContain('auth-plugin');
  });

  it('supports every runtime target', () => {
    for (const runtime of TARGET_RUNTIMES) {
      expect(REST_TEMPLATE.unsupported[runtime]).toBeUndefined();
    }
  });
});

describe('microservice template', () => {
  it('is a strict superset of rest', () => {
    for (const wiring of REST_PLUGINS) {
      expect(symbols(MICROSERVICE_TEMPLATE.plugins)).toContain(wiring.symbol);
    }
    expect(MICROSERVICE_TEMPLATE.plugins.length).toBeGreaterThan(REST_PLUGINS.length);
  });

  it('preserves rest ordering, so runtime still registers first', () => {
    expect(symbols(MICROSERVICE_TEMPLATE.plugins).slice(0, REST_PLUGINS.length))
      .toEqual(symbols(REST_PLUGINS));
  });

  it('adds exactly the service-to-service plugins', () => {
    expect(symbols(MICROSERVICE_TEMPLATE.plugins).slice(REST_PLUGINS.length)).toEqual([
      'MessagingPlugin',
      'QueuePlugin',
      'ResiliencePlugin',
      'TelemetryPlugin',
      'ServiceDiscoveryPlugin',
    ]);
  });

  it('wires service discovery with the static arm, the only one needing no backend', () => {
    // `ServiceDiscoveryPluginOptions` is a union discriminated on `provider`
    // with no default arm, so this wiring is the only one in any template that
    // MUST carry args — a bare call does not type-check. The e2e drift gate is
    // what proves the string itself compiles against the real union; this pins
    // which arm was chosen and that the map is empty.
    const wiring = MICROSERVICE_TEMPLATE.plugins.find(
      (p) => p.symbol === 'ServiceDiscoveryPlugin',
    );

    expect(wiring?.pkg).toBe('service-discovery-plugin');
    expect(wiring?.args).toBe("{ provider: 'static', services: {} }");
  });

  it('leaves the rest template without service discovery', () => {
    // The tier boundary: rest carries ingress concerns, microservice adds the
    // egress ones. Resolving other services is egress, so it stops here.
    expect(symbols(REST_PLUGINS)).not.toContain('ServiceDiscoveryPlugin');
  });

  it('shares rest middleware rather than redeclaring it', () => {
    expect(MICROSERVICE_TEMPLATE.middleware).toEqual(REST_MIDDLEWARE);
  });

  it('refuses Cloudflare Workers with a stated reason', () => {
    const reason = MICROSERVICE_TEMPLATE.unsupported['cloudflare-workers'];
    expect(reason).toBeDefined();
    expect(reason).toContain('sockets');
  });

  it('supports the three socket-capable runtimes', () => {
    for (const runtime of ['deno', 'node', 'bun'] as const) {
      expect(MICROSERVICE_TEMPLATE.unsupported[runtime]).toBeUndefined();
    }
  });
});

describe('every template', () => {
  it('names only @hono-enterprise packages', () => {
    for (const template of listTemplates()) {
      for (const wiring of [...template.plugins, ...template.middleware]) {
        expect(wiring.pkg).not.toContain('@');
        expect(wiring.pkg).not.toContain('/');
      }
    }
  });

  // Templates emit INLINE wiring on purpose, so a scaffolded project owns an
  // explicit, editable plugin list. The one exception composes through a
  // starter FACTORY (`appFactory`), never through a plugin wiring — so a
  // starter package must still never appear in a plugin or middleware list.
  it('never references a starter package in its wirings', () => {
    for (const template of listTemplates()) {
      for (const wiring of [...template.plugins, ...template.middleware]) {
        expect(wiring.pkg).not.toContain('starter');
      }
    }
  });

  it('declares a runtime provider first, unless a factory owns the plugin set', () => {
    for (const template of listTemplates()) {
      if (template.appFactory !== undefined) continue;
      expect(template.plugins[0].symbol).toBe('RuntimePlugin');
    }
  });

  // A factory returns the application, so anything in `plugins` would be
  // silently dropped by the renderer. Enforced across the registry here rather
  // than by a runtime check no user input could ever reach.
  it('lists no plugins when a factory owns the plugin set', () => {
    for (const template of listTemplates()) {
      if (template.appFactory === undefined) continue;
      expect(template.plugins).toEqual([]);
    }
  });

  it('lists each package at most once', () => {
    for (const template of listTemplates()) {
      const packages = [...template.plugins, ...template.middleware].map((w) => w.pkg);
      expect(new Set(packages).size).toBe(packages.length);
    }
  });
});

describe('packagesOf', () => {
  it('deduplicates across lists, preserving first-seen order', () => {
    expect(packagesOf(
      [{ pkg: 'runtime', symbol: 'A' }, { pkg: 'kernel', symbol: 'B' }],
      [{ pkg: 'runtime', symbol: 'C' }, { pkg: 'exceptions', symbol: 'D' }],
    )).toEqual(['runtime', 'kernel', 'exceptions']);
  });

  it('returns an empty list for no wirings', () => {
    expect(packagesOf()).toEqual([]);
  });

  it('covers every package the rest template references', () => {
    const packages = packagesOf(REST_TEMPLATE.plugins, REST_TEMPLATE.middleware);
    expect(packages).toContain('runtime');
    expect(packages).toContain('exceptions');
    expect(packages).toContain('openapi-plugin');
  });
});

describe('nest template', () => {
  it('is the rest set plus DiPlugin', () => {
    expect(symbols(NEST_TEMPLATE.plugins)).toEqual([...symbols(REST_PLUGINS), 'DiPlugin']);
  });

  it('reuses the rest middleware, so errorHandler stays outermost', () => {
    expect(NEST_TEMPLATE.middleware).toEqual(REST_MIDDLEWARE);
  });

  it('carries the decorator class lists as rendered args', () => {
    const decorator = NEST_TEMPLATE.plugins.find((w) => w.pkg === 'decorator-plugin');
    expect(decorator?.args).toBe(
      '{ controllers: [GreetingController], services: [GreetingService] }',
    );
  });

  it('leaves every other wiring argument-free', () => {
    for (const wiring of NEST_TEMPLATE.plugins) {
      if (wiring.pkg === 'decorator-plugin') continue;
      expect(wiring.args).toBeUndefined();
    }
  });

  it('does not mutate the shared REST_PLUGINS list', () => {
    // NEST_PLUGINS is built by mapping REST_PLUGINS; a mutating implementation
    // would leak the args string into the rest and microservice templates.
    const restDecorator = REST_PLUGINS.find((w) => w.pkg === 'decorator-plugin');
    expect(restDecorator?.args).toBeUndefined();
    const microDecorator = MICROSERVICE_TEMPLATE.plugins.find((w) => w.pkg === 'decorator-plugin');
    expect(microDecorator?.args).toBeUndefined();
  });

  it('imports every identifier its args string names', () => {
    const imported = (NEST_TEMPLATE.localImports ?? []).flatMap((l) => l.symbols);
    expect(imported).toContain('GreetingController');
    expect(imported).toContain('GreetingService');
  });

  it('emits a source file for each locally imported module', () => {
    const emitted = (NEST_TEMPLATE.files ?? []).map((f) => `./${f.path}`);
    for (const local of NEST_TEMPLATE.localImports ?? []) {
      expect(emitted).toContain(local.from);
    }
  });

  it('emits exactly the controller and the service', () => {
    expect((NEST_TEMPLATE.files ?? []).map((f) => f.path)).toEqual([
      'src/greeting-service.ts',
      'src/greeting-controller.ts',
    ]);
  });

  it('refuses no runtime target', () => {
    expect(NEST_TEMPLATE.unsupported).toEqual({});
    for (const target of TARGET_RUNTIMES) {
      expect(NEST_TEMPLATE.unsupported[target]).toBeUndefined();
    }
  });

  it('declares di-plugin in the packages a manifest must pin', () => {
    expect(packagesOf(NEST_TEMPLATE.plugins, NEST_TEMPLATE.middleware)).toContain('di-plugin');
  });
});
