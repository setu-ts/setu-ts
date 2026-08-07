/**
 * Builds the configured provider, one overload per arm.
 *
 * Overloading rather than one wide signature keeps a missing credential a
 * compile error: `provider: 'consul'` with no `address` does not type-check,
 * so there is no startup throw to write or test for it.
 *
 * @module
 */
import type { IRuntimeServices } from '@setu-ts/common';
import type { DiscoveryProvider } from '../interfaces/index.ts';
import type {
  ConsulDiscoveryOptions,
  CustomDiscoveryOptions,
  DnsDiscoveryOptions,
  KubernetesDiscoveryOptions,
  ResolvedDiscoveryOptions,
  ServiceDiscoveryPluginOptions,
  StaticDiscoveryOptions,
} from '../options.ts';
import { createDefaultDiscoveryHttp } from '../http/default-http.ts';
import { StaticProvider } from './static-provider.ts';
import { ConsulProvider } from './consul-provider.ts';
import { KubernetesProvider } from './kubernetes-provider.ts';
import { DnsProvider } from './dns-provider.ts';
import { DiscoveryUnavailableError } from '../errors.ts';

/** Default SRV domain template — Consul's own DNS layout. */
const DEFAULT_DOMAIN_TEMPLATE = '{service}.service.consul';

/** Builds the `'static'` provider. */
export function createProvider(
  options: StaticDiscoveryOptions,
  resolved: ResolvedDiscoveryOptions,
  runtime: IRuntimeServices,
): StaticProvider;
/** Builds the `'consul'` provider. */
export function createProvider(
  options: ConsulDiscoveryOptions,
  resolved: ResolvedDiscoveryOptions,
  runtime: IRuntimeServices,
): ConsulProvider;
/** Builds the `'kubernetes'` provider. */
export function createProvider(
  options: KubernetesDiscoveryOptions,
  resolved: ResolvedDiscoveryOptions,
  runtime: IRuntimeServices,
): KubernetesProvider;
/** Builds the `'dns'` provider. */
export function createProvider(
  options: DnsDiscoveryOptions,
  resolved: ResolvedDiscoveryOptions,
  runtime: IRuntimeServices,
): DnsProvider;
/** Returns the application's own provider unchanged. */
export function createProvider(
  options: CustomDiscoveryOptions,
  resolved: ResolvedDiscoveryOptions,
  runtime: IRuntimeServices,
): DiscoveryProvider;
/**
 * Builds the provider for the configured arm.
 *
 * @param options - The application's option literal
 * @param resolved - Options after defaults
 * @param runtime - Runtime services
 * @returns The provider
 * @throws {DiscoveryUnavailableError} If the `'dns'` arm is configured on a
 * runtime with no resolver, or the `'kubernetes'` arm cannot find an API
 * server or a way to read its token
 * @since 0.2.0
 */
export function createProvider(
  options: ServiceDiscoveryPluginOptions,
  resolved: ResolvedDiscoveryOptions,
  runtime: IRuntimeServices,
): DiscoveryProvider {
  switch (options.provider) {
    case 'static':
      return new StaticProvider(options.services, runtime);

    case 'consul':
      return new ConsulProvider(
        {
          address: options.address,
          ...(options.token !== undefined ? { token: options.token } : {}),
          ...(options.datacenter !== undefined ? { datacenter: options.datacenter } : {}),
          waitSeconds: resolved.waitSeconds,
          ...(options.secure !== undefined ? { secure: options.secure } : {}),
        },
        options.http ?? createDefaultDiscoveryHttp(),
        runtime,
      );

    case 'kubernetes': {
      // Checked here rather than inside the API-server resolution, because the
      // token requirement holds whether or not `apiServer` was given.
      if (options.token === undefined && runtime.fs === undefined) {
        throw new DiscoveryUnavailableError(
          "The 'kubernetes' discovery provider needs either an explicit token option " +
            'or IRuntimeServices.fs to read the projected service-account token, and ' +
            'this runtime supplies neither.',
        );
      }
      return new KubernetesProvider(
        {
          namespace: options.namespace,
          apiServer: resolveApiServer(options, runtime),
          ...(options.token !== undefined ? { token: options.token } : {}),
          ...(options.portName !== undefined ? { portName: options.portName } : {}),
          ...(options.secure !== undefined ? { secure: options.secure } : {}),
        },
        options.http ?? createDefaultDiscoveryHttp(),
        runtime,
      );
    }

    case 'dns': {
      if (runtime.dns === undefined) {
        throw new DiscoveryUnavailableError(
          "The 'dns' discovery provider needs IRuntimeServices.dns, which this " +
            'runtime does not supply (Cloudflare Workers has no resolver API). ' +
            "Use the 'static', 'consul', or 'kubernetes' provider instead.",
        );
      }
      const common = {
        domainTemplate: options.domainTemplate ?? DEFAULT_DOMAIN_TEMPLATE,
        ...(options.secure !== undefined ? { secure: options.secure } : {}),
        watchIntervalMs: resolved.watchIntervalMs,
      };
      return new DnsProvider(
        runtime.dns,
        runtime,
        options.mode === 'a'
          ? { ...common, mode: 'a', port: options.port }
          : { ...common, mode: 'srv' },
      );
    }

    default:
      return options.discovery;
  }
}

/**
 * Resolves the Kubernetes API server base URL.
 *
 * Failing here rather than at the first `resolve()` is deliberate: a
 * misconfiguration is a startup error, not a runtime surprise hours later.
 */
function resolveApiServer(
  options: KubernetesDiscoveryOptions,
  runtime: IRuntimeServices,
): string {
  if (options.apiServer !== undefined) {
    return options.apiServer.replace(/\/+$/, '');
  }
  const host = runtime.env.KUBERNETES_SERVICE_HOST;
  const port = runtime.env.KUBERNETES_SERVICE_PORT;
  if (host === undefined || host === '') {
    throw new DiscoveryUnavailableError(
      "The 'kubernetes' discovery provider could not find the API server: " +
        'KUBERNETES_SERVICE_HOST is unset and no apiServer option was given. ' +
        'Set apiServer explicitly when running outside a cluster.',
    );
  }
  return `https://${host}:${port ?? '443'}`;
}
