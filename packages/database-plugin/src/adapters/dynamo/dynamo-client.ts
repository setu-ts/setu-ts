/**
 * Inject-or-lazy loading for the optional DynamoDB AWS SDK.
 *
 * An injected {@linkcode IDynamoClient} never imports the SDK. The lazy arm
 * imports the real `npm:@aws-sdk/client-dynamodb@^3` specifier only when its
 * loader is used, then adapts SDK commands to the structural facade the data
 * source drives.
 *
 * @module
 */
import type {
  DynamoDeleteItemCommandInput,
  DynamoDeleteItemCommandOutput,
  DynamoGetItemCommandInput,
  DynamoGetItemCommandOutput,
  DynamoPutItemCommandInput,
  DynamoPutItemCommandOutput,
  DynamoQueryCommandInput,
  DynamoReadCommandOutput,
  DynamoScanCommandInput,
  DynamoTransactWriteItemsCommandInput,
  DynamoTransactWriteItemsCommandOutput,
  DynamoUpdateItemCommandInput,
  DynamoUpdateItemCommandOutput,
  IDynamoClient,
} from './dynamo-client-types.ts';
import { UnsupportedQueryFeatureError } from '../../errors.ts';

/**
 * AWS client construction settings consumed by the lazy SDK arm.
 *
 * `credentials` remains opaque because the AWS SDK also accepts a credential
 * provider function; it crosses this dependency boundary unchanged.
 *
 * @since 0.1.0
 */
export interface DynamoClientConfiguration {
  /** The AWS region supplied to `DynamoDBClient`. */
  readonly region?: string;
  /** An optional custom endpoint, such as DynamoDB Local. */
  readonly endpoint?: string;
  /** AWS credentials or an SDK-supported credential provider. */
  readonly credentials?: unknown;
}

/** A native DynamoDB SDK command accepted by {@linkcode DynamoSdkClient}. */
export interface DynamoSdkCommand<TInput, TOutput> {
  /** The command request supplied to the AWS SDK. */
  readonly input: TInput;
  /** The typed AWS SDK response, when a command carries one. */
  readonly output?: TOutput;
}

/** The native DynamoDB SDK client operations driven by the facade. */
export interface DynamoSdkClient {
  /** Sends one DynamoDB command to the configured AWS endpoint. */
  send<TInput, TOutput>(command: DynamoSdkCommand<TInput, TOutput>): Promise<TOutput>;
  /** Releases resources owned by the AWS SDK client. */
  destroy(): void;
}

/** A native DynamoDB SDK command constructor. */
export type DynamoCommandConstructor<TInput, TOutput> = new (
  input: TInput,
) => DynamoSdkCommand<TInput, TOutput>;

/**
 * The native `@aws-sdk/client-dynamodb` module shape adapted by the lazy arm.
 *
 * This is deliberately structural so a test double can implement every
 * command constructor without importing the optional SDK.
 *
 * @since 0.1.0
 */
export interface DynamoSdkModule {
  /** The AWS DynamoDB client constructor. */
  DynamoDBClient: new (configuration: DynamoClientConfiguration) => DynamoSdkClient;
  /** The AWS `QueryCommand` constructor. */
  QueryCommand: DynamoCommandConstructor<DynamoQueryCommandInput, DynamoReadCommandOutput>;
  /** The AWS `ScanCommand` constructor. */
  ScanCommand: DynamoCommandConstructor<DynamoScanCommandInput, DynamoReadCommandOutput>;
  /** The AWS `GetItemCommand` constructor. */
  GetItemCommand: DynamoCommandConstructor<DynamoGetItemCommandInput, DynamoGetItemCommandOutput>;
  /** The AWS `PutItemCommand` constructor. */
  PutItemCommand: DynamoCommandConstructor<DynamoPutItemCommandInput, DynamoPutItemCommandOutput>;
  /** The AWS `UpdateItemCommand` constructor. */
  UpdateItemCommand: DynamoCommandConstructor<
    DynamoUpdateItemCommandInput,
    DynamoUpdateItemCommandOutput
  >;
  /** The AWS `DeleteItemCommand` constructor. */
  DeleteItemCommand: DynamoCommandConstructor<
    DynamoDeleteItemCommandInput,
    DynamoDeleteItemCommandOutput
  >;
  /** The AWS `TransactWriteItemsCommand` constructor. */
  TransactWriteItemsCommand: DynamoCommandConstructor<
    DynamoTransactWriteItemsCommandInput,
    DynamoTransactWriteItemsCommandOutput
  >;
}

/** The deferred client-resolution seam used by the adapter lifecycle. */
export interface DynamoClientLoader {
  /** Resolves a client without forcing the injected arm through an SDK import. */
  load(): Promise<IDynamoClient>;
}

/**
 * Creates the no-import arm of the DynamoDB client seam.
 *
 * @param client - An application-owned structural client facade
 * @returns A loader that resolves the supplied client unchanged
 * @since 0.1.0
 */
export function createInjectedDynamoLoader(client: IDynamoClient): DynamoClientLoader {
  return { load: (): Promise<IDynamoClient> => Promise.resolve(client) };
}

/**
 * Refuses a credentialed plaintext endpoint pointed at a remote host.
 *
 * `endpoint` exists so the adapter can address a local emulator, and the
 * emulator speaks plain HTTP on loopback. A REMOTE `http://` endpoint is
 * different: SigV4 signs the request but does not encrypt it, so the
 * credential scope, the table names, the keys and every item body cross the
 * network in cleartext. The AWS SDK does not refuse this, so the adapter does
 * — loopback stays allowed, which is the whole reason the option exists.
 *
 * The check does NOT require `credentials` to be configured. AWS SDK v3 has a
 * credential provider chain (environment, shared config, instance metadata),
 * so an absent `credentials` usually means the SDK will supply some rather
 * than that the request is anonymous — gating on it would leave the common
 * production shape unprotected.
 *
 * @param configuration - The client settings the lazy arm was given
 * @throws {UnsupportedQueryFeatureError} When credentials accompany a remote
 *   `http://` endpoint
 */
function assertTransportSecurity(configuration: DynamoClientConfiguration): void {
  const endpoint = configuration.endpoint;
  // Deliberately NOT gated on `configuration.credentials`. AWS SDK v3 resolves
  // credentials from the environment, shared config and instance metadata when
  // none are passed, so an omitted `credentials` means "the SDK will find some"
  // far more often than it means "this request is anonymous" — and those
  // ambient credentials would then be signed over cleartext exactly as
  // explicit ones would.
  if (endpoint === undefined) return;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new UnsupportedQueryFeatureError(
      'endpoint',
      'dynamodb',
      `DynamoAdapter endpoint '${endpoint}' is not a valid URL.`,
    );
  }
  if (url.protocol !== 'http:') return;
  const host = url.hostname;
  const loopback = host === 'localhost' || host === '127.0.0.1' || host === '::1' ||
    host === '[::1]' || host.endsWith('.localhost');
  if (loopback) return;
  throw new UnsupportedQueryFeatureError(
    'endpoint',
    'dynamodb',
    `DynamoAdapter refuses a plaintext HTTP endpoint on remote host '${host}'. ` +
      `SigV4 signs a request but does not encrypt it, and AWS SDK v3 resolves ambient ` +
      `credentials from the environment or instance metadata even when none are configured, ` +
      `so credential scope, keys and item bodies would cross the network in cleartext. ` +
      `Use https://, or a loopback endpoint for a local emulator.`,
  );
}

/**
 * Creates the lazy DynamoDB SDK loader.
 *
 * The literal import is deliberately inside `load()`: an application that
 * injects a client never resolves or imports the optional AWS SDK.
 *
 * @param configuration - Settings passed to the native `DynamoDBClient`
 * @returns A loader that imports and adapts the AWS SDK when used
 * @since 0.1.0
 */
export function createLazyDynamoLoader(
  configuration: DynamoClientConfiguration,
): DynamoClientLoader {
  assertTransportSecurity(configuration);
  return {
    load: async (): Promise<IDynamoClient> => {
      const module = await import('npm:@aws-sdk/client-dynamodb@^3') as unknown as DynamoSdkModule;
      return adaptDynamoSdkModule(module, configuration);
    },
  };
}

/**
 * Adapts a native DynamoDB SDK module to the structural client facade.
 *
 * @param module - The native SDK module or a structural test double
 * @param configuration - Settings supplied to the native client constructor
 * @returns The structural client driven by database adapter code
 * @since 0.1.0
 */
export function adaptDynamoSdkModule(
  module: DynamoSdkModule,
  configuration: DynamoClientConfiguration,
): IDynamoClient {
  const client = new module.DynamoDBClient(configuration);
  return {
    query: (input: DynamoQueryCommandInput): Promise<DynamoReadCommandOutput> =>
      client.send(new module.QueryCommand(input)),
    scan: (input: DynamoScanCommandInput): Promise<DynamoReadCommandOutput> =>
      client.send(new module.ScanCommand(input)),
    getItem: (input: DynamoGetItemCommandInput): Promise<DynamoGetItemCommandOutput> =>
      client.send(new module.GetItemCommand(input)),
    putItem: (input: DynamoPutItemCommandInput): Promise<DynamoPutItemCommandOutput> =>
      client.send(new module.PutItemCommand(input)),
    updateItem: (input: DynamoUpdateItemCommandInput): Promise<DynamoUpdateItemCommandOutput> =>
      client.send(new module.UpdateItemCommand(input)),
    deleteItem: (input: DynamoDeleteItemCommandInput): Promise<DynamoDeleteItemCommandOutput> =>
      client.send(new module.DeleteItemCommand(input)),
    transactWriteItems: (
      input: DynamoTransactWriteItemsCommandInput,
    ): Promise<DynamoTransactWriteItemsCommandOutput> =>
      client.send(new module.TransactWriteItemsCommand(input)),
    destroy: (): void => client.destroy(),
  };
}
