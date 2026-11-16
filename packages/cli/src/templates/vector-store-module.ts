/**
 * The project-local vector-store adapter module `setu add vector-store` writes
 * for the adapters that need an application-owned client.
 *
 * The client is built in its OWN module rather than inline in `setu.config.ts`,
 * for the reason `templates/node-redis.ts` gives: the configuration classifier
 * (`devtool/sources.ts`) accepts only framework and relative imports, so an
 * `import { QdrantClient } from '@qdrant/js-client-rest'` line there made the
 * whole configuration unclassifiable (`setu.W001`), which hid every other
 * wiring finding. A relative import of this module keeps it decidable.
 *
 * @module
 */

import type { GeneratedFile } from '../utils/file-writer.ts';
import type { TargetRuntime } from '../constants.ts';
import type { ComposeBacking } from '../workspace/transport.ts';
import { workspaceProfile } from '../workspace/runtime-profile.ts';

/** The module's path, relative to the project root. */
export const VECTOR_STORE_MODULE_PATH = 'src/vector-store.ts';

/** The module's exported factory, called once in the plugin's `adapter` option. */
export const VECTOR_STORE_FACTORY = 'vectorStoreAdapter';

/** The adapters whose module this file renders. */
export type ModuleAdapter = 'qdrant' | 'pgvector';

/** The connection each module adapter reads, with its local default. */
export const VECTOR_STORE_CONNECTION: Readonly<
  Record<ModuleAdapter, { readonly variable: string; readonly localDefault: string }>
> = {
  qdrant: { variable: 'QDRANT_URL', localDefault: 'http://127.0.0.1:6333' },
  pgvector: {
    variable: 'DATABASE_URL',
    localDefault: 'postgresql://postgres:postgres@127.0.0.1:5432/app',
  },
};

/** The local Compose backing for each module adapter, in the shape broker arms use. */
export const VECTOR_STORE_COMPOSE: Readonly<
  Record<ModuleAdapter, { readonly name: string; readonly compose: ComposeBacking }>
> = {
  qdrant: {
    name: 'qdrant',
    compose: {
      services: `  qdrant:
    image: qdrant/qdrant:v1.16.3
    ports:
      - '\${QDRANT_PORT:-6333}:6333'
`,
      dependsOn: ['qdrant'],
      condition: 'service_started',
      memberEnv: { QDRANT_URL: 'http://qdrant:6333' },
    },
  },
  pgvector: {
    name: 'pgvector',
    compose: {
      services: `  pgvector:
    image: pgvector/pgvector:pg17
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: app
    ports:
      - '\${POSTGRES_PORT:-5432}:5432'
    healthcheck:
      test: ['CMD', 'pg_isready', '-U', 'postgres']
      interval: 5s
      timeout: 3s
      retries: 10
`,
      dependsOn: ['pgvector'],
      condition: 'service_healthy',
      memberEnv: { DATABASE_URL: 'postgresql://postgres:postgres@pgvector:5432/app' },
    },
  },
};

/** One environment read on one line, in the runtime's own form. */
function envRead(runtime: TargetRuntime, variable: string, fallback: string): string {
  return workspaceProfile(runtime)
    .envRead(variable, fallback)
    .replace(/\s*\n\s*/g, ' ');
}

/**
 * The adapter module's file.
 *
 * @param adapter - Which adapter the module builds
 * @param runtime - The project's runtime, for its environment read
 * @returns The generated `src/vector-store.ts`
 */
export function vectorStoreModuleFile(
  adapter: ModuleAdapter,
  runtime: TargetRuntime,
): GeneratedFile {
  const { variable, localDefault } = VECTOR_STORE_CONNECTION[adapter];
  const url = envRead(runtime, variable, localDefault);
  const contents =
    adapter === 'qdrant'
      ? `/**
 * The Qdrant adapter for VectorStorePlugin, with the application's own client.
 *
 * Built here rather than in setu.config.ts so that file keeps only framework and
 * relative imports, which \`setu check\` can read. Set a client \`timeout\` and an
 * \`apiKey\` for a deployed Qdrant; the adapter never closes this client.
 */
import { QdrantClient } from '@qdrant/js-client-rest';
import { QdrantVectorStore } from '@setu-ts/vector-store-plugin';

/**
 * Builds the adapter on ${variable}.
 *
 * @returns The adapter the plugin's \`adapter\` option takes
 */
export function ${VECTOR_STORE_FACTORY}(): QdrantVectorStore {
  return new QdrantVectorStore({ client: new QdrantClient({ url: ${url} }) });
}
`
      : `/**
 * The pgvector adapter for VectorStorePlugin, over the application's own pool.
 *
 * Built here rather than in setu.config.ts so that file keeps only framework and
 * relative imports, which \`setu check\` can read. Bound the pool
 * (\`connectionTimeoutMillis\`, \`query_timeout\`) for a deployed database.
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { PgVectorStore } from '@setu-ts/vector-store-plugin';

/**
 * Builds the adapter on ${variable}.
 *
 * @returns The adapter the plugin's \`adapter\` option takes
 */
export function ${VECTOR_STORE_FACTORY}(): PgVectorStore {
  return new PgVectorStore({ db: drizzle(${url}) });
}
`;
  return { path: VECTOR_STORE_MODULE_PATH, contents };
}
