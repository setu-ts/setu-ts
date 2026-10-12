/**
 * Every registration `setu add` prints for a provider that needs application
 * configuration, written exactly as printed. `deno check` reaches this file, so
 * a printed line that no longer matches its plugin's option type fails the
 * workspace type-check; `add.test.ts` asserts each printed line appears here
 * verbatim, so the two cannot drift apart.
 *
 * @module
 */
import { AuthPlugin } from '@setu-ts/auth-plugin';
import { CloudflarePlugin } from '@setu-ts/cloudflare-plugin';
import { DatabasePlugin } from '@setu-ts/database-plugin';
import { FeatureFlagsPlugin } from '@setu-ts/feature-flags-plugin';
import { GraphqlPlugin } from '@setu-ts/graphql-plugin';
import { GrpcPlugin } from '@setu-ts/grpc-plugin';
import { MultiTenancyPlugin } from '@setu-ts/multi-tenancy-plugin';
import { NotificationPlugin } from '@setu-ts/notification-plugin';
import { ReactRouterPlugin } from '@setu-ts/react-router-plugin';
import { ServiceDiscoveryPlugin } from '@setu-ts/service-discovery-plugin';
import { SessionPlugin } from '@setu-ts/session-plugin';
import { StaticPlugin } from '@setu-ts/static-plugin';

/** Stands in for the Workers environment the printed line names. */
declare const env: Record<string, unknown>;

/** The printed registrations, constructed against the real option types. */
export const PRINTED_REGISTRATIONS = [
  AuthPlugin({ jwt: { secret: '<your-secret>' }, rbac: { roles: {} } }),
  SessionPlugin({ secret: '<your-secret>' }),
  GrpcPlugin({ services: [] }),
  DatabasePlugin({ type: 'memory' }),
  FeatureFlagsPlugin({ provider: 'memory' }),
  NotificationPlugin({ channels: {} }),
  GraphqlPlugin({ typeDefs: '<your-schema>', resolvers: {} }),
  StaticPlugin({ root: '<public-directory>' }),
  ReactRouterPlugin({ serverBuildPath: '<server-build-module>' }),
  MultiTenancyPlugin({ resolver: 'header' }),
  ServiceDiscoveryPlugin({ provider: 'static', services: {} }),
  CloudflarePlugin({ env }),
];
