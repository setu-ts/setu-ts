import { describe, expect, it } from 'vitest';
import { workspaceProfile } from '../../../src/workspace/runtime-profile.ts';
import { resolveHost } from '../../../src/templates/project-files.ts';
import { getTemplate } from '../../../src/templates/registry.ts';
import { MINIMAL_HOST } from '../../../src/templates/minimal.ts';
import { withWorkspaceMember } from '../../../src/workspace/member-host.ts';
import { BROKERS, brokerSpec } from '../../../src/workspace/transport.ts';
import { TRANSPORT_MODULE, TRANSPORT_SPECIFIER } from '../../../src/workspace/transport-module.ts';
import { rpcSpec } from '../../../src/workspace/rpc.ts';
import {
  DISCOVERY_SPECIFIER,
  SERVICE_ENDPOINTS_EXPORT,
} from '../../../src/workspace/discovery-module.ts';

/** The default transport, which contributes nothing — so those assertions stay about discovery. */
const HTTP = brokerSpec('memory');
const HTTP_RPC = rpcSpec('http');

/**
 * Resolves a template by name, failing the test when it is missing.
 *
 * @param name - The template name
 * @returns Its resolved host
 */
function hostOf(name: string) {
  const template = getTemplate(name);
  expect(template).toBeDefined();
  return resolveHost(template ?? MINIMAL_HOST, 'deno');
}

describe('withWorkspaceMember', () => {
  it('points the discovery wiring at the generated map', () => {
    const member = withWorkspaceMember(hostOf('microservice'), HTTP, HTTP_RPC, 'orders');
    const wiring = member.plugins.find((p) => p.pkg === 'service-discovery-plugin');
    expect(wiring?.args).toBe(`{ provider: 'static', services: ${SERVICE_ENDPOINTS_EXPORT} }`);
  });

  it('brings the map identifier into scope exactly once', () => {
    const member = withWorkspaceMember(hostOf('microservice'), HTTP, HTTP_RPC, 'orders');
    const imports = member.localImports.filter((entry) => entry.from === DISCOVERY_SPECIFIER);
    expect(imports).toEqual([{ symbols: [SERVICE_ENDPOINTS_EXPORT], from: DISCOVERY_SPECIFIER }]);
  });

  it('keeps the template own local imports', () => {
    const base = hostOf('microservice');
    const member = withWorkspaceMember(base, HTTP, HTTP_RPC, 'orders');
    for (const entry of base.localImports) {
      expect(member.localImports).toContainEqual(entry);
    }
  });

  it('leaves every other wiring untouched', () => {
    const base = hostOf('microservice');
    const member = withWorkspaceMember(base, HTTP, HTTP_RPC, 'orders');
    // The discovery, messaging and queue wirings are the only ones the overlay reads.
    const owned = new Set(['service-discovery-plugin', 'messaging-plugin', 'queue-plugin']);
    const others = member.plugins.filter((p) => !owned.has(p.pkg));
    expect(others).toEqual(base.plugins.filter((p) => !owned.has(p.pkg)));
  });

  // Being REACHABLE by siblings and CONSUMING their map are separate
  // properties. A member without the plugin still appears in every other
  // member's map; adding the import here would put an identifier in its config
  // that no wiring reads.
  it('adds no discovery wiring to a member without the discovery plugin', () => {
    for (const base of [hostOf('rest'), resolveHost(MINIMAL_HOST, 'deno')]) {
      const member = withWorkspaceMember(base, HTTP, HTTP_RPC, 'orders');
      expect(member.plugins).toEqual(base.plugins);
      expect(member.localImports.some((entry) => entry.from === DISCOVERY_SPECIFIER)).toBe(false);
    }
  });

  it('passes the generated map through the full-stack starter factory', () => {
    const member = withWorkspaceMember(hostOf('full-stack'), HTTP, HTTP_RPC, 'storefront');

    expect(member.plugins).toEqual([]);
    expect(member.appFactoryContext.serviceEndpoints).toBe(SERVICE_ENDPOINTS_EXPORT);
    expect(member.localImports).toContainEqual({
      symbols: [SERVICE_ENDPOINTS_EXPORT],
      from: DISCOVERY_SPECIFIER,
    });
    expect(
      member.appFactory?.args?.({
        runtime: 'deno',
        ...member.appFactoryContext,
      }),
    ).toContain(`serviceDiscovery: { provider: 'static', services: ${SERVICE_ENDPOINTS_EXPORT} }`);
  });
});

describe('withWorkspaceMember — the transport module', () => {
  /**
   * Applies a broker and RPC style to a template's member.
   *
   * @param template - The template name
   * @param broker - The workspace broker
   * @param rpc - The member's RPC style
   * @returns The member host and its rendered module
   */
  function memberOf(
    template: string,
    broker: Parameters<typeof brokerSpec>[0] = 'memory',
    rpc: 'http' | 'grpc' = 'http',
  ) {
    const member = withWorkspaceMember(
      hostOf(template),
      brokerSpec(broker),
      rpcSpec(rpc),
      'orders',
      workspaceProfile('deno'),
    );
    const module = member.files.find((file) => file.path === TRANSPORT_MODULE);
    return { member, module };
  }

  it('writes a CLI-owned module into every member', () => {
    for (const template of ['rest', 'microservice', 'class-based', 'full-stack']) {
      const { module } = memberOf(template);
      expect(module?.managed).toBe(true);
      expect(module?.contents).toContain('export function transportPlugins()');
    }
  });

  // The template already registers MessagingPlugin, and the kernel refuses a
  // duplicate plugin name at start() — so the config passes the module's options
  // to that one wiring rather than registering a second.
  it('points the template messaging and queue wirings at the module', () => {
    const { member } = memberOf('microservice', 'redis');
    const messaging = member.plugins.filter((p) => p.pkg === 'messaging-plugin');
    expect(messaging).toEqual([expect.objectContaining({ args: 'messagingOptions()' })]);
    // The jobs seam stays in front of the spread, so `setu check` sees it wired.
    expect(member.plugins.find((p) => p.pkg === 'queue-plugin')?.args).toBe(
      '{ processors: [...QUEUE_PROCESSORS], ...queueOptions() }',
    );
    expect(member.pluginSpreads[0]).toBe('...transportPlugins()');
    expect(member.localImports).toContainEqual({
      symbols: ['messagingOptions', 'queueOptions', 'transportPlugins'],
      from: TRANSPORT_SPECIFIER,
    });
  });

  // The config reads the module whatever the broker, so a later broker change
  // regenerates the module and leaves the config alone.
  it('renders the same config calls on every broker', () => {
    const configs = BROKERS.map((broker) => memberOf('microservice', broker).member.plugins);
    for (const plugins of configs) expect(plugins).toEqual(configs[0]);
  });

  it('declares the broker clients the module needs, and none for memory', () => {
    expect(memberOf('microservice', 'redis').member.extraDependencies).toMatchObject({
      ioredis: expect.any(String),
    });
    expect(memberOf('microservice', 'nats').member.extraDependencies).toMatchObject({
      nats: expect.any(String),
    });
    const base = hostOf('microservice').extraDependencies;
    expect(memberOf('microservice', 'memory').member.extraDependencies).toEqual(base);
    // A member with no messaging gets no broker client: nothing would load it.
    expect(memberOf('rest', 'redis').member.extraDependencies).toEqual(
      hostOf('rest').extraDependencies,
    );
  });

  it('carries the broker operational note into the member README', () => {
    expect(memberOf('microservice', 'nats').member.transportNotes?.[0]).toContain('app.');
    expect(memberOf('rest', 'nats').member.transportNotes).toBeUndefined();
  });

  it('writes the node-redis helper the module imports', () => {
    const member = withWorkspaceMember(
      hostOf('microservice'),
      brokerSpec('redis', 'node-redis'),
      HTTP_RPC,
      'orders',
      workspaceProfile('deno'),
    );
    expect(member.files.some((file) => file.path === 'src/node-redis.ts')).toBe(true);
    expect(member.extraDependencies).toMatchObject({ redis: expect.any(String) });
    expect(member.localImports.some((entry) => entry.from === './src/node-redis.ts')).toBe(false);
  });

  // A member whose template registers no messaging must not acquire a bus it
  // never asked for.
  it('adds no messaging wiring to a member whose template has none', () => {
    const base = hostOf('rest');
    const { member, module } = memberOf('rest', 'redis');
    expect(member.plugins).toEqual(base.plugins);
    expect(module?.contents).not.toContain('messagingOptions');
  });

  it('registers the gRPC plugin, clients and toolchain for a grpc member only', () => {
    const grpc = memberOf('microservice', 'redis', 'grpc');
    expect(grpc.module?.contents).toContain("return [GrpcPlugin({ basePath: '/grpc' })];");
    expect(grpc.member.extraFrameworkPackages).toEqual(['grpc-plugin']);
    expect(grpc.member.extraDependencies).toMatchObject({ '@connectrpc/connect': '^2.1.2' });
    expect(grpc.member.files.some((file) => file.path === 'buf.gen.yaml')).toBe(true);
    expect(grpc.member.extraTasks['proto:gen']).toBeDefined();
    // The config does not import the plugin: the module does.
    expect(grpc.member.plugins.some((p) => p.pkg === 'grpc-plugin')).toBe(false);

    const http = memberOf('microservice', 'redis');
    expect(http.member.extraFrameworkPackages).toEqual([]);
    expect(http.member.files.some((file) => file.path === 'buf.gen.yaml')).toBe(false);
  });

  it('gives an npm member the scripts and devDependencies half of the toolchain', () => {
    const member = withWorkspaceMember(
      resolveHost(getTemplate('microservice') ?? MINIMAL_HOST, 'node'),
      HTTP,
      rpcSpec('grpc'),
      'orders',
      workspaceProfile('node'),
    );
    expect(member.extraScripts['proto:gen']).toBeDefined();
    expect(Object.keys(member.extraDevDependencies).length).toBeGreaterThan(0);
    expect(member.extraTasks['proto:gen']).toBeUndefined();
  });

  it('passes the module calls through the full-stack starter factory', () => {
    const { member } = memberOf('full-stack', 'redis', 'grpc');
    expect(member.plugins).toEqual([]);
    expect(member.appFactoryContext).toMatchObject({
      messaging: 'messagingOptions(config)',
      queue: '{ ...queueOptions(config) }',
      csrfExclude: 'csrfExclusions()',
    });
    expect(member.setupCalls[0]).toBe(
      'for (const plugin of transportPlugins()) app.register(plugin);',
    );
    const args = member.appFactory?.args?.({ runtime: 'deno', ...member.appFactoryContext }) ?? '';
    expect(args).toContain('messaging: messagingOptions(config),');
    expect(args).toContain('csrf: { exclude: [...csrfExclusions()] },');
  });

  it('keeps the template own options when the queue has none', () => {
    const base = hostOf('microservice');
    const queue = base.plugins.find((p) => p.pkg === 'queue-plugin')!;
    const bare = withWorkspaceMember(
      { ...base, plugins: base.plugins.map((p) => (p === queue ? { ...p, args: '' } : p)) },
      HTTP,
      HTTP_RPC,
      'orders',
    );
    expect(bare.plugins.find((p) => p.pkg === 'queue-plugin')?.args).toBe('queueOptions()');
    const unset = withWorkspaceMember(
      {
        ...base,
        plugins: base.plugins.map((p) => {
          if (p !== queue) return p;
          const { args: _args, ...rest } = p;
          return rest;
        }),
      },
      HTTP,
      HTTP_RPC,
      'orders',
    );
    expect(unset.plugins.find((p) => p.pkg === 'queue-plugin')?.args).toBe('queueOptions()');
  });

  it('replaces a module the host already carried rather than writing it twice', () => {
    const first = memberOf('microservice').member;
    const again = withWorkspaceMember(first, HTTP, HTTP_RPC, 'orders', workspaceProfile('deno'));
    expect(again.files.filter((file) => file.path === TRANSPORT_MODULE)).toHaveLength(1);
  });

  // Appending a plugin a template already registers would trip the kernel's
  // duplicate-name check, so no combination may collide with any template.
  it('contributes no plugin any template already registers', () => {
    for (const template of ['rest', 'microservice', 'class-based']) {
      for (const broker of BROKERS) {
        for (const rpc of ['http', 'grpc'] as const) {
          const packages = memberOf(template, broker, rpc).member.plugins.map((p) => p.pkg);
          expect(new Set(packages).size).toBe(packages.length);
        }
      }
    }
  });
});
