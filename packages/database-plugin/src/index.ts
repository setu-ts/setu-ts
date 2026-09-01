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
  CosmosAdapterOptions,
  CosmosAdapterOptionsBase,
  CosmosDatabaseOptions,
  CosmosEntityMapping,
  CountOptions,
  CustomDatabaseOptions,
  DatabaseAdapterOptions,
  DatabaseAdapterType,
  DatabaseConnectionOptions,
  DatabasePluginOptions,
  DrizzleAdapterOptions,
  DrizzleCompositeKeyOptions,
  DrizzleDatabaseOptions,
  DynamoAdapterOptions,
  DynamoAdapterOptionsBase,
  DynamoDatabaseOptions,
  FindOptions,
  IDatabaseService,
  IRepository,
  IUnitOfWork,
  MemoryDatabaseOptions,
  MongoAdapterOptions,
  MongoAdapterOptionsBase,
  MongoDatabaseOptions,
  MongoEntityMapping,
  OrderDirection,
  Page,
  PageOptions,
  PrismaAdapterOptions,
  PrismaCompositeKeyOptions,
  PrismaDatabaseOptions,
  PrismaSqlProvider,
} from './interfaces/index.ts';

// Mongo structural types the `'mongodb'` arm carries (injected-client seam),
// including the collection-level shapes the client's members reference so the
// seam's return types stay nameable from the package entry.
export type {
  IMongoClient,
  IMongoCollection,
  IMongoCollectionFindOneAndUpdateOptions,
  IMongoCursor,
  IMongoDatabase,
  IMongoObjectId,
  IMongoObjectIdCtor,
  IMongoSession,
  MongoOptions,
  MongoWriteOptions,
} from './adapters/mongo/mongo-client.ts';

// Cosmos structural types the `'cosmos'` arm carries (injected-client seam).
// An application injecting a real `CosmosClient` annotates it with these, and
// the data source calls exactly these members.
export type {
  CosmosAccessCondition,
  CosmosBatchDeleteOperation,
  CosmosBatchInsertOperation,
  CosmosBatchOperation,
  CosmosBatchPatchOperation,
  CosmosBatchReplaceOperation,
  CosmosBatchResponse,
  CosmosContainerDefinition,
  CosmosFeedResponse,
  CosmosItemResponse,
  CosmosPartitionKeyValue,
  CosmosPatchOperation,
  CosmosQueryParameter,
  CosmosQuerySpec,
  CosmosRequestOptions,
  ICosmosClient,
  ICosmosContainer,
  ICosmosDatabase,
  ICosmosItem,
  ICosmosItems,
  ICosmosQueryIterator,
} from './adapters/cosmos/cosmos-client.ts';

// Errors
export {
  CosmosConcurrentModificationError,
  CosmosTransactionScopeError,
  MongoTransactionUnavailableError,
  UnsupportedFilterOperatorError,
  UnsupportedQueryFeatureError,
  UnsupportedRawQueryError,
} from './errors.ts';

// The data-access port, promoted to `common` in M52c. Re-exported here so a
// backend author can reach the whole contract from one import, and so the
// already-exported `DataSource.findAll` parameter type is finally nameable.
export type {
  CursorPayload,
  CursorValue,
  EntityKey,
  FilterComparison,
  FilterExpression,
  FilterOperator,
  IAdapterTransaction,
  IDatabaseAdapter,
  IDataSource,
  NormalizedQuery,
  PageResult,
} from '@setu-ts/common';
export { decodeCursor, encodeCursor, keysetPredicate } from '@setu-ts/common';

// Services
export { DatabaseService } from './services/database-service.ts';

// Typed native Drizzle query access
export {
  createDrizzleDatabase,
  getDrizzleDatabase,
  getDrizzleTransaction,
} from './query/drizzle-query.ts';
export type {
  DrizzleDatabase,
  DrizzleDatabaseIdentity,
  DrizzleTransaction,
  DrizzleTransactionBridge,
} from './query/drizzle-query.ts';

// The SQL dialect a nested JSON filter path is translated for. Exported
// because `DrizzleAdapterOptions.dialect` is typed by it: without this the
// option's own type is unnameable by a consumer, which is the defect M52c
// found on `NormalizedQuery` reaching a published `DataSource` signature.
export type { SqlJsonDialect } from './query/json-path.ts';

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

// Mongo adapter — document-store backend over the native `mongodb` driver.
export { MongoAdapter } from './adapters/mongo/mongo-adapter.ts';

// DynamoDB adapter — key-value backend over the native AWS SDK v3 client.
// The structural closure keeps the client and SDK seams nameable from this
// entrypoint, matching the MongoDB adapter's injected-client precedent. The
// target resolution, expression builder, marshaller, and access-path resolver
// remain internal (the `D1Target` / `MongoTarget` precedent).
export { DynamoAdapter } from './adapters/dynamo/dynamo-adapter.ts';
export {
  createInjectedDynamoLoader,
  createLazyDynamoLoader,
} from './adapters/dynamo/dynamo-client.ts';
export type {
  DynamoClientConfiguration,
  DynamoClientLoader,
  DynamoCommandConstructor,
  DynamoSdkClient,
  DynamoSdkCommand,
  DynamoSdkModule,
} from './adapters/dynamo/dynamo-client.ts';
export type {
  DynamoAttributeMap,
  DynamoAttributeValue,
  DynamoConditionExpression,
  DynamoDeleteItemCommandInput,
  DynamoDeleteItemCommandOutput,
  DynamoExpressionAttributes,
  DynamoGetItemCommandInput,
  DynamoGetItemCommandOutput,
  DynamoPutItemCommandInput,
  DynamoPutItemCommandOutput,
  DynamoQueryCommandInput,
  DynamoReadCommandInput,
  DynamoReadCommandOutput,
  DynamoScanCommandInput,
  DynamoTransactDelete,
  DynamoTransactPut,
  DynamoTransactUpdate,
  DynamoTransactWriteItem,
  DynamoTransactWriteItemsCommandInput,
  DynamoTransactWriteItemsCommandOutput,
  DynamoUpdateItemCommandInput,
  DynamoUpdateItemCommandOutput,
  IDynamoClient,
} from './adapters/dynamo/dynamo-client-types.ts';
export type {
  DynamoDateEncoding,
  DynamoEntityMapping,
  DynamoIndexMapping,
} from './adapters/dynamo/dynamo-mapping.ts';
// Cosmos adapter — Azure Cosmos DB NoSQL-API backend over `@azure/cosmos`.
export { CosmosAdapter } from './adapters/cosmos/cosmos-adapter.ts';
