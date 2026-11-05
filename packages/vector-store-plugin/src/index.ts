/**
 * Tenant-scoped vector retrieval: a thin store whose tenant scope is a
 * required argument and whose filters are refused, never ignored. The port and
 * errors live in `@setu-ts/common`; this package provides the plugin, the
 * service and the memory, pgvector and Qdrant adapters.
 *
 * @module
 */
export { VectorStorePlugin } from './plugin/vector-store-plugin.ts';
export type { VectorStorePluginOptions } from './plugin/vector-store-plugin.ts';
export type { VectorStoreTenancy } from './services/vector-store-service.ts';
export { MemoryVectorStore } from './adapters/memory/memory-vector-store.ts';
export type { MemoryVectorStoreOptions } from './adapters/memory/memory-vector-store.ts';
export { PgVectorStore } from './adapters/pgvector/pgvector-store.ts';
export type {
  PgVectorDatabase,
  PgVectorExecutor,
  PgVectorStoreOptions,
} from './adapters/pgvector/pgvector-store.ts';
export { QdrantVectorStore } from './adapters/qdrant/qdrant-store.ts';
export type { QdrantClientLike, QdrantVectorStoreOptions } from './adapters/qdrant/qdrant-store.ts';
export { VERSION } from './version.ts';
