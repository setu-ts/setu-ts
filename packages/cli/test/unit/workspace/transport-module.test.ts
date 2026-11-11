import { describe, expect, it } from 'vitest';
import {
  renderTransportModule,
  TRANSPORT_MODULE,
  TRANSPORT_SPECIFIER,
  transportModuleShape,
  type TransportModuleInput,
} from '../../../src/workspace/transport-module.ts';
import { BROKERS, brokerSpec, type BrokerName } from '../../../src/workspace/transport.ts';
import { rpcSpec } from '../../../src/workspace/rpc.ts';
import { workspaceProfile } from '../../../src/workspace/runtime-profile.ts';

/**
 * Builds a module input with defaults for everything a case does not name.
 *
 * @param overrides - The fields the case sets
 * @returns The input
 */
function input(
  overrides: Partial<Omit<TransportModuleInput, 'broker' | 'rpc'>> & {
    readonly broker?: BrokerName;
    readonly rpc?: 'http' | 'grpc';
    readonly nodeRedis?: boolean;
  } = {},
): TransportModuleInput {
  const { broker = 'memory', rpc = 'http', nodeRedis = false, ...rest } = overrides;
  return {
    broker: brokerSpec(broker, nodeRedis ? 'node-redis' : 'ioredis'),
    rpc: rpcSpec(rpc),
    host: 'plugin-list',
    profile: workspaceProfile('deno'),
    messaging: true,
    queue: true,
    ...rest,
  };
}

describe('the transport module', () => {
  it('lives at one CLI-owned path the config imports', () => {
    expect(TRANSPORT_MODULE).toBe('src/transport/index.ts');
    expect(TRANSPORT_SPECIFIER).toBe(`./${TRANSPORT_MODULE}`);
  });

  it('says the CLI owns it and names the commands that change it', () => {
    const module = renderTransportModule(input());
    expect(module).toContain('The CLI owns this file');
    expect(module).toContain('setu workspace broker <name>');
    expect(module).toContain('setu workspace rpc <member> <http|grpc>');
  });

  // Every broker × host kind × RPC style: the functions it exports match the
  // shape the config renderer reads, and nothing is read at import time.
  for (const broker of BROKERS) {
    for (const host of ['plugin-list', 'app-factory'] as const) {
      for (const rpc of ['http', 'grpc'] as const) {
        it(`renders ${broker} / ${host} / ${rpc} with exactly the shape's exports`, () => {
          const value = input({ broker, host, rpc });
          const module = renderTransportModule(value);
          const shape = transportModuleShape(value);
          expect(module.includes('export function messagingOptions(')).toBe(shape.messaging);
          expect(module.includes('export function queueOptions(')).toBe(shape.queue);
          expect(module.includes('export function csrfExclusions(')).toBe(shape.csrf);
          expect(module).toContain('export function transportPlugins(): readonly IPlugin[] {');
          // No module-scope read: every environment or config access is inside
          // a function body, so importing the config for `setu commands` reads
          // nothing.
          const topLevel = module
            .split('\n')
            .filter((line) => !line.startsWith(' ') && !line.startsWith('}'));
          expect(topLevel.join('\n')).not.toMatch(/Deno\.env|process\.env|config\.get/);
          expect(module.includes("from '@setu-ts/grpc-plugin'")).toBe(rpc === 'grpc');
          // Typed through the starter on a factory host, which declares neither plugin.
          expect(module.includes("from '@setu-ts/messaging-plugin'")).toBe(host === 'plugin-list');
          expect(module.includes("from '@setu-ts/full-stack-starter'")).toBe(
            host === 'app-factory',
          );
          // Every line inside the 100-column budget the generated formatter uses.
          // A lone string literal (the Service Bus emulator default) is exempt: no
          // formatter breaks a string, and today's configs carry the same line.
          for (const line of module.split('\n')) {
            if (/^\s*'[^']*'[,)]*;?$/.test(line)) continue;
            expect(line.length).toBeLessThanOrEqual(100);
          }
        });
      }
    }
  }

  it('returns the same options the standalone overlay passes, on a plugin-list host', () => {
    const module = renderTransportModule(input({ broker: 'redis' }));
    expect(module).toContain(
      "  return {\n    broker: 'redis-streams',\n    url: Deno.env.get('REDIS_URL') ??\n      'redis://127.0.0.1:6379',\n  };",
    );
    expect(module).toContain("    adapter: 'redis',");
  });

  it('reads the environment the profile names on npm targets', () => {
    const module = renderTransportModule(
      input({ broker: 'rabbitmq', profile: workspaceProfile('node') }),
    );
    expect(module).toContain('process.env.RABBITMQ_URL');
    expect(module).not.toContain('Deno.env');
  });

  it('honors the workspace endpoint override as the fallback', () => {
    const module = renderTransportModule(
      input({ broker: 'redis', brokerUrl: 'redis://shared:6379' }),
    );
    expect(module).toContain("'redis://shared:6379'");
    expect(module).not.toContain('127.0.0.1');
  });

  it('reads config on an app-factory host and names an unused parameter _config', () => {
    const redis = renderTransportModule(input({ broker: 'redis', host: 'app-factory' }));
    expect(redis).toContain(
      'export function messagingOptions(config: IConfig): StarterMessagingOptions {',
    );
    expect(redis).toContain(
      "config.get<string>('REDIS_URL', { default: 'redis://127.0.0.1:6379' })",
    );
    // NATS has no queue arm: the queue stays in memory and reads nothing.
    const nats = renderTransportModule(input({ broker: 'nats', host: 'app-factory' }));
    expect(nats).toContain('export function queueOptions(_config: IConfig): StarterQueueOptions {');
    expect(nats).toContain('in memory, since the queue has no nats arm');
    const memory = renderTransportModule(input({ host: 'app-factory' }));
    expect(memory).toContain('export function messagingOptions(_config: IConfig)');
    expect(memory).toContain('  return {};');
  });

  it('exports only what a plugin-list member registers', () => {
    const rest = renderTransportModule(input({ messaging: false, queue: false }));
    expect(rest).not.toContain('messagingOptions');
    expect(rest).not.toContain('queueOptions');
    expect(rest).not.toContain("from '@setu-ts/messaging-plugin'");
    const queueOnly = renderTransportModule(input({ messaging: false }));
    expect(queueOnly).toContain('export function queueOptions(): QueuePluginOptions {');
    expect(queueOnly).not.toContain('messagingOptions');
  });

  it('gives a factory host both option functions whatever its plugin list says', () => {
    expect(
      transportModuleShape(input({ host: 'app-factory', messaging: false, queue: false })),
    ).toEqual({
      messaging: true,
      queue: true,
      csrf: true,
    });
  });

  it('imports the project-local node-redis helper only where a client is built', () => {
    const module = renderTransportModule(input({ broker: 'redis', nodeRedis: true }));
    expect(module).toContain("import { nodeRedisClient } from '../node-redis.ts';");
    expect(module).toContain('client: nodeRedisClient(');
    const rest = renderTransportModule(
      input({ broker: 'redis', nodeRedis: true, messaging: false, queue: false }),
    );
    expect(rest).not.toContain('nodeRedisClient');
  });

  it('registers and exempts the gRPC mount only for a grpc member', () => {
    const grpc = renderTransportModule(input({ host: 'app-factory', rpc: 'grpc' }));
    expect(grpc).toContain("  return [GrpcPlugin({ basePath: '/grpc' })];");
    expect(grpc).toContain("  return [new RegExp('^/grpc(?:/|$)')];");
    const http = renderTransportModule(input({ host: 'app-factory' }));
    expect(http).not.toContain('GrpcPlugin');
    expect(http).not.toContain('new RegExp');
    // The config's own reader refuses a backslash or a regex literal.
    expect(grpc).not.toContain('\\');
  });
});

describe('the transport module — gRPC callers (M139b §3.12)', () => {
  it('registers the client only, serving nothing, for a member that calls gRPC members', () => {
    const module = renderTransportModule(input({ grpcTargets: ['billing', 'tax-rates'] }));
    expect(module).toContain("import { GrpcPlugin } from '@setu-ts/grpc-plugin';");
    expect(module).toContain(
      "  return [GrpcPlugin({ serve: false, clients: { billing: { basePath: '/grpc' }, 'tax-rates': { basePath: '/grpc' } } })];",
    );
    expect(module).toContain(
      " * The plugins this member's RPC style adds: `GrpcPlugin` for calling `billing`, `tax-rates` only — this member serves no gRPC.",
    );
  });

  it('adds the clients to a gRPC member that also calls, and exempts only its own mount', () => {
    const module = renderTransportModule(
      input({ host: 'app-factory', rpc: 'grpc', grpcTargets: ['billing'] }),
    );
    expect(module).toContain(
      "  return [GrpcPlugin({ basePath: '/grpc', clients: { billing: { basePath: '/grpc' } } })];",
    );
    expect(module).toContain(
      " * The plugins this member's RPC style adds: `GrpcPlugin`, mounted under `/grpc`, with clients for `billing`.",
    );
    expect(module).toContain("  return [new RegExp('^/grpc(?:/|$)')];");
  });

  it('a caller on an app-factory host exempts nothing from CSRF', () => {
    const module = renderTransportModule(input({ host: 'app-factory', grpcTargets: ['billing'] }));
    expect(module).toContain('export function csrfExclusions(): readonly RegExp[] {\n  return [];');
  });

  it('an empty target list renders as before', () => {
    expect(renderTransportModule(input({ grpcTargets: [] }))).toBe(renderTransportModule(input()));
  });
});
