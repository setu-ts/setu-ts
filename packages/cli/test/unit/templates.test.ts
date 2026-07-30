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
    ]);
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
  // explicit, editable plugin list. (Before M36 the starters were also empty
  // stubs; they are real composition libraries now, so the reason is the
  // inline-wiring choice, not emptiness. A `--starter` flag is future work.)
  it('never references a starter package', () => {
    for (const template of listTemplates()) {
      for (const wiring of [...template.plugins, ...template.middleware]) {
        expect(wiring.pkg).not.toContain('starter');
      }
    }
  });

  it('declares a runtime provider first', () => {
    for (const template of listTemplates()) {
      expect(template.plugins[0].symbol).toBe('RuntimePlugin');
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
