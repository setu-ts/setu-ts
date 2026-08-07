/**
 * @module
 *
 * Database plugin with repository pattern, Unit of Work, and ORM adapters.
 *
 * Provides `DatabasePlugin` for registering database access through the
 * framework's plugin system. Supports Prisma, Drizzle, and in-memory
 * adapters. Every export is documented in PUBLIC_API.md (AI_GUIDELINES §10).
 */

// Plugin factory
export { DatabasePlugin } from './plugin/database-plugin.ts';

// Public interfaces
export type {
  BuiltInDatabaseOptions,
  CountOptions,
  CustomDatabaseOptions,
  DatabaseAdapterOptions,
  DatabaseAdapterType,
  DatabaseConnectionOptions,
  DatabasePluginOptions,
  FindOptions,
  IDatabaseService,
  IRepository,
  IUnitOfWork,
  OrderDirection,
} from './interfaces/index.ts';

// The data-access port, promoted to `common` in M52c. Re-exported here so a
// backend author can reach the whole contract from one import, and so the
// already-exported `DataSource.findAll` parameter type is finally nameable.
export type {
  IAdapterTransaction,
  IDatabaseAdapter,
  IDataSource,
  NormalizedQuery,
} from '@setu-ts/common';

// Services
export { DatabaseService } from './services/database-service.ts';

// Repository
export { BaseRepository } from './repositories/base-repository.ts';
export type { DataSource } from './repositories/base-repository.ts';

// Unit of Work
export { UnitOfWork } from './unitOfWork/unit-of-work.ts';

// Adapters
export { MemoryAdapter } from './adapters/memory/memory-adapter.ts';
export { PrismaAdapter } from './adapters/prisma/prisma-adapter.ts';
export { PrismaRepository } from './adapters/prisma/prisma-repository.ts';
export { createPrismaDataSource } from './adapters/prisma/prisma-repository.ts';
export { DrizzleAdapter } from './adapters/drizzle/drizzle-adapter.ts';
export { DrizzleRepository } from './adapters/drizzle/drizzle-repository.ts';
export { createDrizzleDataSource } from './adapters/drizzle/drizzle-repository.ts';
