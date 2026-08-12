import { describe, it } from '@std/testing/bdd';
import { workspaceProfile } from '../../../src/workspace/runtime-profile.ts';
import { expect } from '@std/expect';
import { resolveHost } from '../../../src/templates/project-files.ts';
import { getTemplate } from '../../../src/templates/registry.ts';
import { MINIMAL_HOST } from '../../../src/templates/minimal.ts';
import { withWorkspaceMember } from '../../../src/workspace/member-host.ts';
import { transportSpec } from '../../../src/workspace/transport.ts';
import {
  DISCOVERY_SPECIFIER,
  SERVICE_ENDPOINTS_EXPORT,
} from '../../../src/workspace/discovery-module.ts';

/** The default transport, which contributes nothing — so those assertions stay about discovery. */
const HTTP = transportSpec('http');

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
    const member = withWorkspaceMember(hostOf('microservice'), HTTP, 'orders');
    const wiring = member.plugins.find((p) => p.pkg === 'service-discovery-plugin');
    expect(wiring?.args).toBe(
      `{ provider: 'static', services: ${SERVICE_ENDPOINTS_EXPORT} }`,
    );
  });

  it('brings the map identifier into scope exactly once', () => {
    const member = withWorkspaceMember(hostOf('microservice'), HTTP, 'orders');
    const imports = member.localImports.filter((entry) => entry.from === DISCOVERY_SPECIFIER);
    expect(imports).toEqual([{ symbols: [SERVICE_ENDPOINTS_EXPORT], from: DISCOVERY_SPECIFIER }]);
  });

  it('keeps the template own local imports', () => {
    const base = hostOf('microservice');
    const member = withWorkspaceMember(base, HTTP, 'orders');
    for (const entry of base.localImports) {
      expect(member.localImports).toContainEqual(entry);
    }
  });

  it('leaves every other wiring untouched', () => {
    const base = hostOf('microservice');
    const member = withWorkspaceMember(base, HTTP, 'orders');
    const others = member.plugins.filter((p) => p.pkg !== 'service-discovery-plugin');
    expect(others).toEqual(base.plugins.filter((p) => p.pkg !== 'service-discovery-plugin'));
  });

  // Being REACHABLE by siblings and CONSUMING their map are separate
  // properties. A member without the plugin still appears in every other
  // member's map; adding the import here would put an identifier in its config
  // that no wiring reads.
  it('changes nothing for a member without the discovery plugin', () => {
    const base = hostOf('rest');
    expect(withWorkspaceMember(base, HTTP, 'orders')).toEqual(base);
  });

  it('changes nothing for a member scaffolded with no template', () => {
    const base = resolveHost(MINIMAL_HOST, 'deno');
    expect(withWorkspaceMember(base, HTTP, 'orders')).toEqual(base);
  });
});

describe('withWorkspaceMember — the transport overlay', () => {
  /**
   * Reads the messaging wiring of a microservice member under one transport.
   *
   * @param name - The transport to apply
   * @param url - The workspace's endpoint override, when it set one
   * @returns The member's `MessagingPlugin` wiring
   */
  function messagingOf(name: Parameters<typeof transportSpec>[0], url?: string) {
    const member = withWorkspaceMember(
      hostOf('microservice'),
      transportSpec(name),
      'orders',
      workspaceProfile('deno'),
      url,
    );
    return member.plugins.find((p) => p.pkg === 'messaging-plugin');
  }

  // The template already registers MessagingPlugin, and the kernel refuses a
  // duplicate plugin name at start() — so a broker REWRITES that wiring. A
  // second registration would scaffold a member that type-checks and cannot boot.
  it('rewrites the template messaging wiring rather than adding a second one', () => {
    const member = withWorkspaceMember(hostOf('microservice'), transportSpec('redis'), 'orders');
    const messaging = member.plugins.filter((p) => p.pkg === 'messaging-plugin');
    expect(messaging).toHaveLength(1);
    // An environment read with the local address as its FALLBACK, not a literal:
    // inside a container 127.0.0.1 is the container itself, so the Compose stack
    // has to be able to override it.
    expect(messaging[0]?.args).toBe(
      "{ broker: 'redis-streams', url: Deno.env.get('REDIS_URL') ??\n          'redis://127.0.0.1:6379' }",
    );
  });

  it('uses the transport default endpoint when the workspace names none', () => {
    expect(messagingOf('nats')?.args).toContain('nats://127.0.0.1:4222');
  });

  it('honors the workspace endpoint override', () => {
    // The override replaces the FALLBACK, not the environment read: a deployed
    // stack still has to be able to point a member elsewhere.
    const args = messagingOf('redis', 'redis://shared:6379')?.args ?? '';
    expect(args).toContain("Deno.env.get('REDIS_URL')");
    expect(args).toContain('redis://shared:6379');
    expect(args).not.toContain('127.0.0.1');
  });

  it('leaves the messaging wiring alone for http, grpc and memory', () => {
    const base = hostOf('microservice');
    const untouched = base.plugins.find((p) => p.pkg === 'messaging-plugin');
    for (const name of ['http', 'grpc', 'memory'] as const) {
      expect(messagingOf(name)).toEqual(untouched);
    }
  });

  it('registers the gRPC plugin for the grpc transport', () => {
    const member = withWorkspaceMember(hostOf('microservice'), transportSpec('grpc'), 'orders');
    expect(member.plugins.filter((p) => p.pkg === 'grpc-plugin')).toHaveLength(1);
  });

  // A member whose template registers no messaging must not acquire a bus it
  // never asked for — there is no wiring to rewrite, so a broker is inert.
  it('adds no messaging wiring to a member whose template has none', () => {
    const base = hostOf('rest');
    const member = withWorkspaceMember(base, transportSpec('redis'), 'orders');
    expect(member.plugins.some((p) => p.pkg === 'messaging-plugin')).toBe(false);
    expect(member.plugins).toEqual(base.plugins);
  });

  // Appending a transport plugin a template already registers would trip the
  // kernel's duplicate-name check, so no transport may collide with any template.
  it('contributes no plugin any template already registers', () => {
    for (const template of ['rest', 'microservice', 'class-based']) {
      const base = hostOf(template);
      for (
        const name of ['http', 'grpc', 'memory', 'redis', 'rabbitmq', 'nats', 'kafka'] as const
      ) {
        const member = withWorkspaceMember(base, transportSpec(name), 'orders');
        const packages = member.plugins.map((p) => p.pkg);
        expect(new Set(packages).size).toBe(packages.length);
      }
    }
  });
});
