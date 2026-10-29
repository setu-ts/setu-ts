/**
 * The committed external-version table for the Node build (M111a plan §3.1).
 *
 * `scripts/node-manifests.ts` generates every member's `package.json` from the
 * imports it scans; each EXTERNAL specifier it finds must carry a range, and
 * this table is the only source of one. A scanned external absent here fails
 * the generator with its name — adding a dependency to a `src` tree therefore
 * means adding its range in the same change, which is what keeps the two
 * toolchains (Deno's import resolution and pnpm's install) agreeing on one
 * range table rather than two that can disagree.
 *
 * Ranges are the ones the `npm:` specifiers carried before M111a rewrote them
 * to bare specifiers, so the rewrite moved syntax, not versions. `hono` carries
 * the range `@hono/hono` declared on JSR (`^4.12.30`): M111a moves Deno onto the
 * same npm artifact production loads without narrowing the range consumers
 * were promised, and without moving the version the lockfile already holds.
 *
 * `OVERRIDES` is the committed classification exceptions, each with the reason
 * the plan gave (§3.1). The generator refuses an override without a reason
 * string so the table cannot accumulate unexplained entries.
 *
 * @module
 */

/** The range a scanned external specifier is listed at. */
export const EXTERNAL_RANGES: Readonly<Record<string, string>> = {
  esbuild: '~0.28.0',
  prettier: '^3.9.10',
  tsx: '^4.23.0',
  typescript: '6.0.3',
  vitest: '5.0.3',
  'zod-v4': 'npm:zod@^4.6.6',
  'xml-crypto': '^6',
  '@simplewebauthn/server': '14.0.3',
  '@prisma/adapter-pg': '^7.10.0',
  pg: '^8.0.0',
  hono: '^4.12.30',
  '@hono/node-server': '^2.0.0',
  '@opentelemetry/api': '^1.9.0',
  '@opentelemetry/context-async-hooks': '^2.0.0',
  '@opentelemetry/exporter-trace-otlp-http': '^0.220.0',
  '@opentelemetry/instrumentation-amqplib': '^0.67.0',
  '@opentelemetry/instrumentation-http': '^0.220.0',
  '@opentelemetry/instrumentation-ioredis': '^0.68.0',
  '@opentelemetry/instrumentation-redis': '^0.69.0',
  '@opentelemetry/instrumentation-kafkajs': '^0.29.0',
  '@opentelemetry/instrumentation-undici': '^0.30.0',
  '@opentelemetry/resources': '^2.9.0',
  '@opentelemetry/sdk-trace-base': '^2.9.0',
  '@aws-sdk/client-dynamodb': '^3',
  '@aws-sdk/client-s3': '^3',
  '@aws-sdk/client-secrets-manager': '^3',
  '@aws-sdk/client-sesv2': '^3',
  '@aws-sdk/client-sns': '^3',
  '@aws-sdk/client-sqs': '^3',
  '@aws-sdk/s3-request-presigner': '^3',
  '@azure/cosmos': '^4',
  '@azure/identity': '^4',
  '@azure/keyvault-secrets': '^4',
  '@azure/service-bus': '^7',
  '@azure/storage-blob': '^12',
  '@bufbuild/protobuf': '^2.7.0',
  '@connectrpc/connect': '^2.1.2',
  '@google-cloud/bigtable': '^6',
  '@google-cloud/pubsub': '^6',
  '@google-cloud/secret-manager': '^5',
  '@google-cloud/storage': '^7',
  '@launchdarkly/node-server-sdk': '^9',
  '@node-saml/node-saml': '^5',
  '@types/ws': '^8.18.2',
  '@types/pg': '^8.23.1',
  '@types/amqplib': '^0.10.8',
  '@types/swagger-ui-dist': '^3.30.6',
  '@prisma/client': '^7.10.0',
  amqplib: '0.10.x',
  'drizzle-orm': '0.45.2',
  graphql: '^16',
  ioredis: '5.x',
  redis: '6.x',
  kafkajs: '2.x',
  mongodb: '^6.21.0',
  nats: '2.x',
  nodemailer: '^10',
  pino: '10.x',
  'swagger-ui-dist': '^5',
  'react-router': '^8',
  ws: '^8.18.0',
  zod: '^4.6.6',
};

/**
 * A classification exception. `kind` selects the rule the generator applies
 * instead of the one the import scan produced; `reason` is required and is
 * printed with any failure naming this override.
 */
export interface Override {
  readonly package: string;
  readonly dependency: string;
  readonly kind: 'regular-dependency' | 'dev-dependency-types';
  readonly reason: string;
}

/** The committed overrides (M111a plan §3.1), each with its reason. */
export const OVERRIDES: readonly Override[] = [
  {
    package: 'packages/openapi-plugin',
    dependency: '@types/swagger-ui-dist',
    kind: 'dev-dependency-types',
    reason:
      'The guarded CommonJS absolute-path helper has no bundled declarations; source-based README and guide compilers must resolve its function signature (M113f).',
  },
  {
    package: 'packages/database-plugin',
    dependency: '@types/pg',
    kind: 'dev-dependency-types',
    reason:
      'The PostgreSQL test harnesses import pg, which ships no declarations (M111e2 check, TS7016).',
  },
  {
    package: 'packages/idempotency-plugin',
    dependency: '@types/pg',
    kind: 'dev-dependency-types',
    reason:
      'The real-backend within fixture imports pg and is included in the Node type-check gate (M111e2).',
  },
  {
    package: 'packages/websocket-plugin',
    dependency: '@types/ws',
    kind: 'dev-dependency-types',
    reason:
      'The declarative route test imports ws; its declarations are required by the Node type-check gate (M111e2).',
  },
  {
    package: 'packages/cli',
    dependency: 'prettier',
    kind: 'regular-dependency',
    reason:
      'the CLI formats every file it writes into an npm-target project with ' +
      'Prettier (utils/prettier-format.ts), so a fresh scaffold passes its own ' +
      '`npm run format:check` — loaded lazily, but required (M111d §3.7, maintainer-approved)',
  },
  {
    package: 'packages/cli',
    dependency: 'tsx',
    kind: 'regular-dependency',
    reason:
      'the CLI loads every project TypeScript module (setu.config.ts, custom ' +
      'schematics) through tsx (utils/ts-loader.ts), so `npx @setu-ts/cli` must ' +
      'carry it — an optional peer is never installed for the consumer (M111d §3.3)',
  },
  {
    package: 'packages/runtime',
    dependency: '@hono/node-server',
    kind: 'regular-dependency',
    reason:
      "the Node HTTP adapter's ONLY serve path loads it (node-http-adapter.ts), " +
      'so a bare `npm install @setu-ts/runtime` must serve on Node',
  },
  {
    package: 'packages/runtime',
    dependency: '@types/ws',
    kind: 'dev-dependency-types',
    reason:
      '`ws` is the one optional peer whose types the tsc build needs: its ' +
      'untyped import is TS7016 (node-ws-upgrader.ts) while amqplib/nodemailer ' +
      'type-check without @types',
  },
  {
    package: 'packages/messaging-plugin',
    dependency: '@types/amqplib',
    kind: 'dev-dependency-types',
    reason:
      'amqplib ships no types and its untyped import is TS7016 once it is ' +
      'INSTALLED (rabbitmq-broker.ts) — the plan §1 probe saw only `ws` fail ' +
      'because its tree had amqplib unresolved, not installed; the same ' +
      'correction applies to queue-plugin',
  },
  {
    package: 'packages/queue-plugin',
    dependency: '@types/amqplib',
    kind: 'dev-dependency-types',
    reason:
      'amqplib ships no types and its untyped import is TS7016 once it is ' +
      'INSTALLED (rabbitmq-queue.ts); same correction as messaging-plugin',
  },
];

/** The workspace-internal specifier prefix every cross-package import uses. */
export const WORKSPACE_SCOPE = '@setu-ts/';
