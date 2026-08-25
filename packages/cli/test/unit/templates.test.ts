import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { TARGET_RUNTIMES, TEMPLATES } from '../../src/constants.ts';
import {
  getTemplate,
  listTemplates,
  packagesOf,
  type Wiring,
} from '../../src/templates/registry.ts';
import { MINIMAL_HOST } from '../../src/templates/minimal.ts';
import { REST_MIDDLEWARE, REST_PLUGINS, REST_TEMPLATE } from '../../src/templates/rest.ts';
import { MICROSERVICE_TEMPLATE } from '../../src/templates/microservice.ts';
import { CLASS_BASED_TEMPLATE } from '../../src/templates/class-based.ts';

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

describe('MINIMAL_HOST plugins', () => {
  it('is the runtime provider alone', () => {
    expect(symbols(MINIMAL_HOST.plugins)).toEqual(['RuntimePlugin']);
  });

  it('registers no middleware', () => {
    // The default scaffold has no error handler; only templates add one.
    expect(MINIMAL_HOST.plugins.every((w) => w.pkg !== 'exceptions')).toBe(true);
    expect(MINIMAL_HOST.middleware).toEqual([]);
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
    ]);
  });

  it('adds errorHandler as MIDDLEWARE, never as a plugin', () => {
    // `@setu-ts/exceptions` ships a MiddlewareFunction, not an IPlugin.
    expect(symbols(REST_TEMPLATE.middleware)).toEqual(['errorHandler']);
    expect(symbols(REST_TEMPLATE.plugins)).not.toContain('errorHandler');
    expect(REST_TEMPLATE.plugins.every((w) => w.pkg !== 'exceptions')).toBe(true);
  });

  it('excludes plugins that need credentials before they do anything', () => {
    const packages = REST_TEMPLATE.plugins.map((w) => w.pkg);
    expect(packages).not.toContain('database-plugin');
    expect(packages).not.toContain('auth-plugin');
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

  // `CqrsPlugin` and `EventsPlugin` are here because this is the only template that can
  // HOST the CQRS and event-handler seams: all three of those schematics are gated on
  // plugins no template installed, so their output could never be wired in a scaffolded
  // project. Both are in-memory and zero-configuration, so they satisfy the tier's rule
  // that a scaffolded plugin must construct with no credentials.
  it('adds exactly the service-to-service plugins', () => {
    expect(symbols(MICROSERVICE_TEMPLATE.plugins).slice(REST_PLUGINS.length)).toEqual([
      'MessagingPlugin',
      'QueuePlugin',
      'ResiliencePlugin',
      'TelemetryPlugin',
      'CqrsPlugin',
      'EventsPlugin',
      'ServiceDiscoveryPlugin',
    ]);
  });

  it('is the only template hosting the cqrs and events seams', () => {
    const cqrs = MICROSERVICE_TEMPLATE.plugins.find((p) => p.symbol === 'CqrsPlugin');
    const events = MICROSERVICE_TEMPLATE.plugins.find((p) => p.symbol === 'EventsPlugin');
    expect(cqrs?.args).toBe(
      '{ commandHandlers: COMMAND_HANDLERS, queryHandlers: QUERY_HANDLERS }',
    );
    expect(events?.args).toBe('{ handlers: EVENT_HANDLERS }');
    // And the barrels they read are emitted from scaffold time, so a fresh project is
    // wired before anything is generated.
    const paths = (MICROSERVICE_TEMPLATE.files ?? []).map((f) => f.path);
    expect(paths).toContain('src/cqrs/index.ts');
    expect(paths).toContain('src/events/index.ts');
  });

  it('keeps neither plugin in the Workers swap, since neither needs a socket', () => {
    // The swap replaces only what the platform genuinely cannot serve. CQRS and
    // events are in-memory, so swapping them out would remove a capability
    // Workers supports perfectly well.
    const removed = MICROSERVICE_TEMPLATE.runtimeSwaps?.['cloudflare-workers']?.removePackages ??
      [];

    expect(removed).not.toContain('cqrs-plugin');
    expect(removed).not.toContain('events-plugin');
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

  // The refusal this template used to carry was template-level and
  // unconditional. It was right about the two plugins and wrong about the
  // capabilities: Cloudflare serves both messaging and queues itself, so the
  // tier keeps them from a different provider rather than losing the target.
  it('no longer refuses Cloudflare Workers, and swaps instead', () => {
    const swap = MICROSERVICE_TEMPLATE.runtimeSwaps?.['cloudflare-workers'];
    expect(swap?.removePackages).toEqual(['messaging-plugin', 'queue-plugin']);
    expect(swap?.addPlugins.map((wiring) => wiring.pkg)).toEqual(['cloudflare-plugin']);
  });

  it('swaps on Workers only, leaving the socket-capable runtimes alone', () => {
    for (const runtime of ['deno', 'node', 'bun'] as const) {
      expect(MICROSERVICE_TEMPLATE.runtimeSwaps?.[runtime]).toBeUndefined();
    }
  });
});

describe('every template', () => {
  it('names only @setu-ts packages', () => {
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
    for (const template of [...listTemplates(), MINIMAL_HOST]) {
      for (const wiring of [...template.plugins, ...template.middleware]) {
        expect(wiring.pkg).not.toContain('starter');
      }
    }
  });

  it('declares a runtime provider first, unless a factory owns the plugin set', () => {
    // MINIMAL_HOST is included: it is a TemplateHost like the rest, and the
    // kernel makes the runtime capability mandatory at start() whichever host
    // built the project.
    for (const host of [...listTemplates(), MINIMAL_HOST]) {
      if (host.appFactory !== undefined) continue;
      expect(host.plugins[0].symbol).toBe('RuntimePlugin');
    }
  });

  it('renders each factory template from its runtime alone', () => {
    for (const template of listTemplates()) {
      const args = template.appFactory?.args;
      if (args === undefined) continue;
      for (const runtime of TARGET_RUNTIMES) {
        expect(args({ runtime }).length).toBeGreaterThan(0);
      }
    }
  });

  it('lists no plugins when a factory owns the plugin set', () => {
    for (const host of [...listTemplates(), MINIMAL_HOST]) {
      if (host.appFactory === undefined) continue;
      expect(host.plugins).toEqual([]);
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

describe('class-based template', () => {
  it('is the functional REST set plus decorators and DI', () => {
    expect(symbols(CLASS_BASED_TEMPLATE.plugins)).toEqual([
      ...symbols(REST_PLUGINS),
      'DecoratorPlugin',
      'DiPlugin',
    ]);
  });

  it('reuses the rest middleware, so errorHandler stays outermost', () => {
    expect(CLASS_BASED_TEMPLATE.middleware).toEqual(REST_MIDDLEWARE);
  });

  it('carries the decorator class lists as rendered args', () => {
    // The showcase classes are no longer named individually: E4 moved them into
    // the seam directories, so `APP_CONTROLLERS`/`APP_SERVICES` already carry
    // them and a second literal entry would register each one twice. Order is
    // still load-bearing — the standalone barrels come before the module one, so
    // `setu g controller` and `setu g module` both ADD to this registration.
    const decorator = CLASS_BASED_TEMPLATE.plugins.find((w) => w.pkg === 'decorator-plugin');
    expect(decorator?.args).toBe(
      '{\n' +
        '        controllers: [...APP_CONTROLLERS, ...MODULE_CONTROLLERS],\n' +
        '        services: [...APP_SERVICES, ...MODULE_SERVICES],\n' +
        '      }',
    );
  });

  it('leaves every wiring without a seam argument-free, except di-plugin', () => {
    // Three plugins take a seam, and — since M70d (E3) — `di-plugin` emits
    // `autoRegister: true`, because the default disables the container's only
    // route to the framework. Everything else must stay a bare call, or a
    // template has grown configuration nothing asked for.
    //
    // `config-plugin` is deliberately NOT in this set: its dotenv argument is
    // template MANIFEST data rendered by `configModule`, so a literal on the
    // wiring as well would be a second source of truth that `--env-file`
    // silently overrides.
    const withArgs = new Set([
      'decorator-plugin',
      'health-plugin',
      'metrics-plugin',
      'di-plugin',
      // M70f (C3): validation answers in the same Problem Details shape the
      // `errorHandler` emits for thrown errors, so it carries an `errorFormat`.
      'validation-plugin',
    ]);
    for (const wiring of CLASS_BASED_TEMPLATE.plugins) {
      if (withArgs.has(wiring.pkg)) {
        expect(wiring.args).toBeDefined();
        continue;
      }
      expect(wiring.args).toBeUndefined();
    }
  });

  it('emits DiPlugin({ autoRegister: true }), not a bare call (E3)', () => {
    // A bare `DiPlugin()` leaves `autoRegister` at its `false` default, so every
    // `@Inject(CAPABILITIES.X)` throws at startup. The one file the developer
    // does not hand-edit must set it.
    const di = CLASS_BASED_TEMPLATE.plugins.find((w) => w.pkg === 'di-plugin');
    expect(di?.args).toBe('{ autoRegister: true }');
  });

  it('does not leak its example classes into the shared REST_PLUGINS list', () => {
    // CLASS_BASED_PLUGINS is built from REST_PLUGINS; a mutating implementation
    // would leak the args string into the rest and microservice templates.
    //
    expect(REST_PLUGINS.some((w) => w.pkg === 'decorator-plugin')).toBe(false);

    // The other templates must not have picked up the class-based showcase.
    for (const plugins of [REST_TEMPLATE.plugins, MICROSERVICE_TEMPLATE.plugins]) {
      const decorator = plugins.find((w) => w.pkg === 'decorator-plugin');
      expect(decorator).toBeUndefined();
    }
  });

  it('imports every identifier its args string names', () => {
    const imported = (CLASS_BASED_TEMPLATE.localImports ?? []).flatMap((l) => l.symbols);
    expect(imported).toContain('APP_CONTROLLERS');
    expect(imported).toContain('APP_SERVICES');
    expect(imported).toContain('MODULE_CONTROLLERS');
    expect(imported).toContain('MODULE_SERVICES');
  });

  it('reaches the showcase through the seam barrels, not an explicit path', () => {
    // E4: the config used to import the two classes by path, which is the
    // signal a developer copies — and it pointed at `src/` root rather than the
    // directories `setu generate` writes to.
    const froms = (CLASS_BASED_TEMPLATE.localImports ?? []).map((l) => l.from);
    expect(froms).not.toContain('./src/greeting-service.ts');
    expect(froms).not.toContain('./src/greeting-controller.ts');
    expect(froms).toContain('./src/services/index.ts');
    expect(froms).toContain('./src/controllers/index.ts');
  });

  it('seeds the showcase into the SCAFFOLDED barrels, before anything is generated', () => {
    // Without the seed the showcase would sit in a seam directory registered by
    // nothing until the first `setu generate` regenerated the barrel around it.
    const files = CLASS_BASED_TEMPLATE.files ?? [];
    const controllers = files.find((f) => f.path === 'src/controllers/index.ts');
    const services = files.find((f) => f.path === 'src/services/index.ts');
    expect(controllers?.contents).toContain('GreetingController');
    expect(services?.contents).toContain('GreetingService');
  });

  it('emits a source file for each locally imported module', () => {
    const emitted = (CLASS_BASED_TEMPLATE.files ?? []).map((f) => `./${f.path}`);
    for (const local of CLASS_BASED_TEMPLATE.localImports ?? []) {
      expect(emitted).toContain(local.from);
    }
  });

  it('emits the controller, the service, and every seam barrel it can consume', () => {
    expect((CLASS_BASED_TEMPLATE.files ?? []).map((f) => f.path)).toEqual([
      // In the seam directories, under the seam naming convention (E4).
      'src/services/greeting.service.ts',
      'src/controllers/greeting.controller.ts',
      'src/modules/index.ts',
      // ONE HTTP barrel, shared by the controller and route kinds since E8.
      'src/controllers/index.ts',
      'src/services/index.ts',
      'src/middleware/index.ts',
      'src/plugins/index.ts',
      'src/health/index.ts',
      'src/metrics/index.ts',
    ]);
  });

  it('hosts class seams without the microservice cqrs or events seams', () => {
    const seamPaths = (files: readonly { readonly path: string }[]) =>
      files.map((f) => f.path).filter((p) => p.endsWith('/index.ts')).sort();
    expect(seamPaths(CLASS_BASED_TEMPLATE.files ?? [])).not.toContain('src/cqrs/index.ts');
    expect(seamPaths(REST_TEMPLATE.files ?? [])).not.toContain('src/events/index.ts');
  });

  it('declares di-plugin in the packages a manifest must pin', () => {
    expect(packagesOf(CLASS_BASED_TEMPLATE.plugins, CLASS_BASED_TEMPLATE.middleware)).toContain(
      'di-plugin',
    );
  });
});
