/**
 * The starter factories a configuration may compose through, and the option arm
 * each starter owns for a plugin.
 *
 * Two commands read this. `setu add` explains where a plugin belongs when a
 * starter builds the composition, rather than telling the developer to register
 * a second instance. `setu generate` reads it to know that a generated decorator
 * barrel belongs in a starter's own `decorators` arm, not in an inline
 * `DecoratorPlugin(...)` the config does not have.
 *
 * Detection is by imported package specifier, with comments masked — a
 * commented-out import is not a composition. Any starter import counts, because
 * either form registers plugins the CLI never names, and a second registration
 * is a duplicate plugin name at boot.
 *
 * @module
 */

import { maskComments, packageSpecifierCount } from '../devtool/sources.ts';

/** Starter-owned options, including optional arms that must first be configured. */
const REST_ARMS: ReadonlyMap<string, string> = new Map([
  ['config-plugin', 'config'],
  ['logger-plugin', 'logger'],
  ['validation-plugin', 'validation'],
  ['http-security-plugin', 'httpSecurity'],
  ['health-plugin', 'health'],
  ['metrics-plugin', 'metrics'],
  ['openapi-plugin', 'openapi'],
  ['decorator-plugin', 'decorators'],
  ['database-plugin', 'database'],
  ['auth-plugin', 'auth'],
  ['websocket-plugin', 'realtime.websocket'],
  ['sse-plugin', 'realtime.sse'],
  ['realtime-backplane-plugin', 'realtime.backplane'],
  ['session-plugin', 'session'],
  ['di-plugin', 'di'],
  ['graphql-plugin', 'graphql'],
  ['service-discovery-plugin', 'serviceDiscovery'],
]);
const MICROSERVICE_ARMS: ReadonlyMap<string, string> = new Map([
  ...REST_ARMS,
  ['messaging-plugin', 'messaging'],
  ['queue-plugin', 'queue'],
  ['resilience-plugin', 'resilience'],
  ['telemetry-plugin', 'telemetry'],
]);
const FULL_STACK_ARMS: ReadonlyMap<string, string> = new Map([
  ...MICROSERVICE_ARMS,
  ['cache-plugin', 'cache'],
  ['events-plugin', 'events'],
  ['cqrs-plugin', 'cqrs'],
  ['scheduler-plugin', 'scheduler'],
  ['audit-plugin', 'audit'],
  ['secrets-plugin', 'secrets'],
  ['storage-plugin', 'storage'],
  ['mail-plugin', 'mail'],
  ['feature-flags-plugin', 'featureFlags'],
  ['notification-plugin', 'notifications'],
  ['multi-tenancy-plugin', 'multiTenancy'],
  ['react-router-plugin', 'reactRouter'],
  ['static-plugin', 'static'],
]);

/** The starter factories whose import marks a starter-composed configuration. */
export const STARTER_ARMS: readonly {
  readonly symbol: string;
  readonly pkg: string;
  readonly arms: ReadonlyMap<string, string>;
}[] = [
  { symbol: 'createRestApp', pkg: 'rest-starter', arms: REST_ARMS },
  { symbol: 'createMicroserviceApp', pkg: 'microservice-starter', arms: MICROSERVICE_ARMS },
  { symbol: 'createFullStackAppFromConfig', pkg: 'full-stack-starter', arms: FULL_STACK_ARMS },
] as const;

/**
 * The starter a configuration composes through, if it imports one at all.
 *
 * Read with comments masked where the file classifies, else from raw text,
 * which errs toward starter guidance rather than toward a duplicate
 * registration the CLI cannot see.
 *
 * @param source - The configuration source
 * @returns The starter entry, or `undefined` when none is imported
 */
export function composingStarter(source: string): (typeof STARTER_ARMS)[number] | undefined {
  const visible = maskComments(source) ?? source;
  return STARTER_ARMS.find(({ pkg }) => packageSpecifierCount(visible, pkg) > 0);
}
