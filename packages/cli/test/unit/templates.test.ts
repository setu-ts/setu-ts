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

  it('keeps neither plugin on the Workers refusal, since neither needs a socket', () => {
    expect(MICROSERVICE_TEMPLATE.unsupported['cloudflare-workers']).toContain(
      'messaging and queue',
    );
    expect(MICROSERVICE_TEMPLATE.unsupported['cloudflare-workers']).not.toContain('cqrs');
    expect(MICROSERVICE_TEMPLATE.unsupported['cloudflare-workers']).not.toContain('events');
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

  it('states only blockers that apply to the config it actually generates', () => {
    // The reason is shown verbatim to a user whose scaffold was refused, so it
    // must describe THIS template's wiring. Service discovery is wired with the
    // `'static'` arm, which contacts no backend — only `DnsProvider` reads
    // `IRuntimeServices.dns`, and nothing here selects it. Citing DNS-SRV would
    // name a blocker the generated config never meets, and would imply the
    // discovery plugin is unusable on Workers when its static, Consul and
    // Kubernetes arms are plain HTTP.
    const reason = MICROSERVICE_TEMPLATE.unsupported['cloudflare-workers'] ?? '';

    expect(reason).toMatch(/messaging/i);
    expect(reason).toMatch(/queue/i);
    expect(reason).not.toMatch(/dns/i);
    expect(reason).not.toMatch(/discovery/i);
  });

  it('supports the three socket-capable runtimes', () => {
    for (const runtime of ['deno', 'node', 'bun'] as const) {
      expect(MICROSERVICE_TEMPLATE.unsupported[runtime]).toBeUndefined();
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
    // Order is load-bearing: the example classes come first, then the standalone
    // controller and service barrels, then the module barrel — so `setu g controller`
    // and `setu g module` both ADD to this registration rather than displacing the
    // template's own showcase classes.
    const decorator = NEST_TEMPLATE.plugins.find((w) => w.pkg === 'decorator-plugin');
    expect(decorator?.args).toBe(
      '{\n' +
        '        controllers: [GreetingController, ...APP_CONTROLLERS, ...MODULE_CONTROLLERS],\n' +
        '        services: [GreetingService, ...APP_SERVICES, ...MODULE_SERVICES],\n' +
        '      }',
    );
  });

  it('leaves every wiring without a seam argument-free', () => {
    // Three plugins now take a seam. Everything else must stay a bare call, or a
    // template has grown configuration nothing asked for.
    const withSeams = new Set(['decorator-plugin', 'health-plugin', 'metrics-plugin']);
    for (const wiring of NEST_TEMPLATE.plugins) {
      if (withSeams.has(wiring.pkg)) {
        expect(wiring.args).toBeDefined();
        continue;
      }
      expect(wiring.args).toBeUndefined();
    }
  });

  it('does not leak its example classes into the shared REST_PLUGINS list', () => {
    // NEST_PLUGINS is built by mapping REST_PLUGINS; a mutating implementation
    // would leak the args string into the rest and microservice templates.
    //
    // `REST_PLUGINS` is the raw constant, so its decorator entry carries no args
    // at all — the seam is applied per template, not to the shared list.
    const restDecorator = REST_PLUGINS.find((w) => w.pkg === 'decorator-plugin');
    expect(restDecorator?.args).toBeUndefined();

    // The other two templates DO carry the seams, but must not have picked up nest's
    // showcase classes along with them.
    for (const plugins of [REST_TEMPLATE.plugins, MICROSERVICE_TEMPLATE.plugins]) {
      const decorator = plugins.find((w) => w.pkg === 'decorator-plugin');
      expect(decorator?.args).toContain('...APP_CONTROLLERS, ...MODULE_CONTROLLERS');
      expect(decorator?.args).toContain('...APP_SERVICES, ...MODULE_SERVICES');
      expect(decorator?.args).not.toContain('Greeting');
    }
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

  it('emits the controller, the service, and every seam barrel it can consume', () => {
    expect((NEST_TEMPLATE.files ?? []).map((f) => f.path)).toEqual([
      'src/greeting-service.ts',
      'src/greeting-controller.ts',
      'src/modules/index.ts',
      'src/controllers/index.ts',
      'src/services/index.ts',
      'src/routes/index.ts',
      'src/middleware/index.ts',
      'src/plugins/index.ts',
      'src/health/index.ts',
      'src/metrics/index.ts',
    ]);
  });

  // `nest` is the REST set plus `DiPlugin`, and `DiPlugin` hosts no seam — so its seam
  // list must equal the REST one. A divergence here means the two templates picked up
  // different seam sets, which is exactly the drift the shared `REST_SEAMS` prevents.
  it('hosts the same seams as rest, and neither hosts the cqrs or events ones', () => {
    const seamPaths = (files: readonly { readonly path: string }[]) =>
      files.map((f) => f.path).filter((p) => p.endsWith('/index.ts')).sort();
    expect(seamPaths(NEST_TEMPLATE.files ?? [])).toEqual(seamPaths(REST_TEMPLATE.files ?? []));
    expect(seamPaths(NEST_TEMPLATE.files ?? [])).not.toContain('src/cqrs/index.ts');
    expect(seamPaths(REST_TEMPLATE.files ?? [])).not.toContain('src/events/index.ts');
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
