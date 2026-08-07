/**
 * @module
 *
 * Service discovery for Setu-TS — turns a logical service name into a
 * reachable address, balances across the instances behind it, and takes them
 * out of rotation when callers report failures.
 *
 * Registers an `IServiceDiscovery` under `CAPABILITIES.SERVICE_DISCOVERY`,
 * backed by a pluggable provider: a literal `'static'` list, `'consul'`,
 * `'kubernetes'` EndpointSlices, `'dns'` (SRV and address records), or the
 * application's own `'custom'` provider. Zero npm dependencies — the HTTP
 * providers run on web-standard `fetch` and the DNS provider on the optional
 * `IRuntimeServices.dns`.
 *
 * @example
 * ```typescript
 * import { createApplication } from '@setu-ts/kernel';
 * import { RuntimePlugin } from '@setu-ts/runtime';
 * import { ServiceDiscoveryPlugin } from '@setu-ts/service-discovery-plugin';
 * import { CAPABILITIES, type IServiceDiscovery } from '@setu-ts/common';
 *
 * const app = createApplication({
 *   plugins: [
 *     RuntimePlugin(),
 *     ServiceDiscoveryPlugin({
 *       provider: 'consul',
 *       address: 'http://127.0.0.1:8500',
 *     }),
 *   ],
 * });
 *
 * await app.start({ port: 3000 });
 *
 * const discovery = app.services.get<IServiceDiscovery>(
 *   CAPABILITIES.SERVICE_DISCOVERY,
 * );
 * const url = await discovery.resolveUrl('billing', '/invoices');
 * ```
 */

export { ServiceDiscoveryPlugin } from './plugin/service-discovery-plugin.ts';

export type {
  ADnsDiscoveryOptions,
  ConsulDiscoveryOptions,
  CustomDiscoveryOptions,
  DnsDiscoveryOptions,
  KubernetesDiscoveryOptions,
  ServiceDiscoveryPluginOptions,
  SrvDnsDiscoveryOptions,
  StaticDiscoveryOptions,
} from './options.ts';

export type {
  DiscoveryHttpResponse,
  DiscoveryHttpStream,
  DiscoveryProvider,
  EjectionOptions,
  IDiscoveryHttp,
  SelfRegistration,
  SelfRegistrationCheck,
  StaticServiceDefinition,
} from './interfaces/index.ts';

export { createDefaultDiscoveryHttp } from './http/default-http.ts';

export { StaticProvider } from './providers/static-provider.ts';
export { ConsulProvider } from './providers/consul-provider.ts';
export type { ConsulProviderOptions } from './providers/consul-provider.ts';
export { KubernetesProvider } from './providers/kubernetes-provider.ts';
export type { KubernetesProviderOptions } from './providers/kubernetes-provider.ts';
export { DnsProvider } from './providers/dns-provider.ts';
export type { DnsProviderOptions } from './providers/dns-provider.ts';

export { DiscoveryUnavailableError, SelfRegistrationNotSupportedError } from './errors.ts';
