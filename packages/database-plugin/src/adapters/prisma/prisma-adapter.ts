// deno-lint-ignore-file require-await -- transaction stubs must be async for ITransaction interface
/**
 * Prisma ORM adapter — lazily loads Prisma via `npm:prisma` import or
 * accepts an injected client.
 *
 * @module
 */
import type { ILogger, IOrmAdapter, ITransaction } from '@hono-enterprise/common';
import type { DatabaseAdapterOptions } from '../../interfaces/index.ts';

// Prisma client type — lazily resolved.
type PrismaClient = {
  $connect(): Promise<void>;
  $disconnect(): Promise<void>;
  $transaction<T>(fn: (client: unknown) => Promise<T>): Promise<T>;
  $use(
    param: { name: string; query: (e: unknown, n: () => Promise<unknown>) => Promise<unknown> },
  ): void;
};

/**
 * Prisma adapter wrapping the official Prisma client.
 *
 * The client is either injected via `options.prismaClient` or lazily loaded
 * through `import('npm:prisma')`.
 *
 * @since 0.1.0
 */
export class PrismaAdapter implements IOrmAdapter {
  private _client: PrismaClient | null = null;
  private _connected = false;
  private readonly _options: DatabaseAdapterOptions | undefined;
  private readonly _logger: ILogger | undefined;

  constructor(options?: DatabaseAdapterOptions, logger?: ILogger) {
    this._options = options ?? undefined;
    this._logger = logger ?? undefined;
  }

  /** @inheritdoc */
  async connect(): Promise<void> {
    this._client = await this.resolveClient();
    await this._client.$connect();
    this._connected = true;

    if (this._options?.logQueries) {
      this.enableQueryLogging();
    }
  }

  /** @inheritdoc */
  async disconnect(): Promise<void> {
    if (this._client) {
      await this._client.$disconnect();
    }
    this._connected = false;
  }

  /** @inheritdoc */
  isReady(): boolean {
    return this._connected && this._client !== null;
  }

  /** @inheritdoc */
  async beginTransaction(): Promise<ITransaction> {
    if (!this.isReady()) {
      throw new Error('PrismaAdapter is not connected — call connect() first');
    }

    return {
      async commit(): Promise<void> {
        // Prisma transactions are managed via callback in DatabaseService.
      },
      async rollback(): Promise<void> {
        // Prisma transactions are managed via callback in DatabaseService.
      },
    };
  }

  /**
   * Resolve the Prisma client from options or lazy import.
   *
   * @returns Prisma client instance
   * @throws {Error} If Prisma cannot be loaded
   */
  private async resolveClient(): Promise<PrismaClient> {
    // Prefer injected client.
    if (this._options?.prismaClient) {
      return this._options.prismaClient as PrismaClient;
    }

    // Lazy-load Prisma.
    try {
      const prismaModule = await import('npm:@prisma/client@7.8.0');
      const PrismaClient = (prismaModule as Record<string, unknown>).PrismaClient as new (
        opts: Record<string, unknown>,
      ) => PrismaClient;
      const client = new PrismaClient({
        datasources: { db: { url: this._options?.url } },
      });
      return client;
    } catch (error) {
      throw new Error(
        `Failed to load Prisma: ${
          (error as Error).message
        }. Install @prisma/client or inject via options.prismaClient.`,
      );
    }
  }

  /**
   * Enable query logging middleware on the Prisma client.
   * Logs every query execution using the injected logger.
   */
  private enableQueryLogging(): void {
    const logger = this._logger;
    if (!this._client || !logger) return;
    this._client.$use({
      name: 'query-logger',
      query: async (e, next) => {
        const param = e as Record<string, unknown>;
        const result = await next();
        logger.debug(
          `[Prisma] ${param.model}.${param.action}`,
          { model: param.model, action: param.action },
        );
        return result;
      },
    });
  }
}
