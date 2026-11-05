import type { IRuntimeServices, IVectorStoreAdapter } from '@setu-ts/common';
import { MemoryVectorStore, PgVectorStore } from '@setu-ts/vector-store-plugin';
import type { PgVectorDatabase } from '@setu-ts/vector-store-plugin';

/**
 * The vector store backend: PostgreSQL with pgvector 0.8+ when `PGVECTOR_URL`
 * is set, otherwise process memory (lost on restart, one process only). The
 * pool is closed when the application stops.
 *
 * @param runtime - Runtime services; the URL is read from `runtime.env`
 * @returns The adapter `VectorStorePlugin` opens during registration
 */
export async function createDocumentsAdapter(
  runtime: IRuntimeServices,
): Promise<IVectorStoreAdapter> {
  const url = runtime.env['PGVECTOR_URL'];
  if (url === undefined || url === '') return new MemoryVectorStore();
  const { Pool } = await import('pg');
  const { drizzle } = await import('drizzle-orm/node-postgres');
  // Bounded, so a hung database answers 503/504 instead of holding requests.
  const pool = new Pool({
    connectionString: url,
    max: 5,
    connectionTimeoutMillis: 5_000,
    query_timeout: 15_000,
  });
  return new PgVectorStore({
    db: drizzle(pool) as unknown as PgVectorDatabase,
    onClose: () => pool.end(),
  });
}
