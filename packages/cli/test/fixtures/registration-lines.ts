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
import { MemoryVectorStore, VectorStorePlugin } from '@setu-ts/vector-store-plugin';
import type { IVectorStoreAdapter } from '@setu-ts/common';
import { MailPlugin } from '@setu-ts/mail-plugin';
import type { DatabasePluginOptions } from '@setu-ts/database-plugin';

/** Stands in for the Deno global a Deno project's printed mail line reads. */
declare const Deno: { readonly env: { get(name: string): string | undefined } };

/** Stands in for the Workers environment the printed line names. */
declare const env: Record<string, unknown>;

/** Stands in for the platform sink the printed line names (M113d §3.8). */
declare const waitUntil: ((promise: Promise<unknown>) => void) | undefined;

declare const drizzleInstance: Extract<
  DatabasePluginOptions,
  { type: 'drizzle' }
>['options']['drizzleInstance'];
declare const drizzleTables: Record<string, unknown>;
declare const prismaClient: Extract<
  DatabasePluginOptions,
  { type: 'prisma' }
>['options']['prismaClient'];
/** Stands in for the factory `setu add vector-store` writes to src/vector-store.ts. */
declare function vectorStoreAdapter(): IVectorStoreAdapter;
declare const databaseUrl: string;
declare const region: string;
declare const endpoint: string;
declare const key: string;
declare const database: string;
declare const projectId: string;
declare const instance: string;

/** The printed registrations, constructed against the real option types. */
export const PRINTED_REGISTRATIONS = [
  // prettier-ignore
  MailPlugin({ provider: 'smtp', options: { host: process.env.SMTP_HOST || 'localhost', port: Number(process.env.SMTP_PORT || '587') } }),
  // prettier-ignore
  MailPlugin({ provider: 'smtp', options: { host: Deno.env.get('SMTP_HOST') || 'localhost', port: Number(Deno.env.get('SMTP_PORT') || '587') } }),
  MailPlugin({ provider: 'ses', options: {} }),
  MailPlugin({ provider: 'sendgrid', options: { apiKey: process.env.SENDGRID_API_KEY || '' } }),
  MailPlugin({ provider: 'sendgrid', options: { apiKey: Deno.env.get('SENDGRID_API_KEY') || '' } }),
  DatabasePlugin({ type: 'drizzle', options: { drizzleInstance, drizzleTables } }),
  DatabasePlugin({ type: 'prisma', options: { prismaClient } }),
  DatabasePlugin({ type: 'mongodb', options: { url: databaseUrl, collections: {} } }),
  DatabasePlugin({ type: 'dynamodb', options: { region, entities: {} } }),
  DatabasePlugin({ type: 'cosmos', options: { endpoint, key, database, containers: {} } }),
  DatabasePlugin({ type: 'bigtable', options: { projectId, instance, tables: {} } }),
  // prettier-ignore
  VectorStorePlugin({ adapter: vectorStoreAdapter(), collections: [{ name: 'documents', dimensions: 768 }] }),
  AuthPlugin({ jwt: {}, rbac: { roles: {} } }),
  SessionPlugin(),
  GrpcPlugin({ services: [] }),
  DatabasePlugin({ type: 'memory' }),
  FeatureFlagsPlugin({ provider: 'memory' }),
  NotificationPlugin({ channels: {} }),
  GraphqlPlugin({ typeDefs: '<your-schema>', resolvers: {} }),
  StaticPlugin({ root: '<public-directory>' }),
  ReactRouterPlugin({ serverBuildPath: '<server-build-module>' }),
  MultiTenancyPlugin({ resolver: 'header' }),
  ServiceDiscoveryPlugin({ provider: 'static', services: {} }),
  // prettier-ignore
  VectorStorePlugin({ adapter: new MemoryVectorStore(), collections: [{ name: 'documents', dimensions: 768 }] }),
  // The only runtime `setu add cloudflare` accepts is cloudflare-workers, so
  // the printed form is the one whose factory takes `waitUntil` second
  // (M113d §3.8). The spread is required under `exactOptionalPropertyTypes`:
  // `setu commands` calls the factory with no `waitUntil`.
  CloudflarePlugin({ env, ...(waitUntil ? { waitUntil } : {}) }),
];
