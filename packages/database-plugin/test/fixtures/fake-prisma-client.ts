// deno-lint-ignore-file require-await -- async methods must match real Prisma client interface
/**
 * Fake Prisma client for unit testing the PrismaAdapter.
 *
 * Honors the real Prisma client's $connect/$disconnect/$transaction/$use shapes
 * so adapter tests can exercise the connection lifecycle without needing
 * @prisma/client installed or a schema.prisma file.
 *
 * @module
 */

/**
 * Create a fake Prisma client instance.
 *
 * @returns Fake Prisma client with connect/disconnect/transaction/middleware hooks.
 */
export function createFakePrismaClient(): {
  $connect: () => Promise<void>;
  $disconnect: () => Promise<void>;
  $transaction: <T>(fn: (client: unknown) => Promise<T>) => Promise<T>;
  $use: (param: {
    name: string;
    query: (e: unknown, n: () => Promise<unknown>) => Promise<unknown>;
  }) => void;
  connected: boolean;
  disconnected: boolean;
  middlewares: Array<{
    name: string;
    query: (e: unknown, n: () => Promise<unknown>) => Promise<unknown>;
  }>;
} {
  let connected = false;
  let disconnected = false;
  const middlewares: Array<{
    name: string;
    query: (e: unknown, n: () => Promise<unknown>) => Promise<unknown>;
  }> = [];

  return {
    get connected() {
      return connected;
    },
    get disconnected() {
      return disconnected;
    },
    middlewares,
    async $connect() {
      connected = true;
      disconnected = false;
      // Invoke registered middleware callbacks to exercise enableQueryLogging body.
      for (const mw of middlewares) {
        await mw.query(
          { model: 'User', action: 'findMany', args: {} },
          async () => [],
        );
      }
    },
    async $disconnect() {
      disconnected = true;
      connected = false;
    },
    async $transaction<T>(fn: (client: unknown) => Promise<T>): Promise<T> {
      return fn(this);
    },
    $use(param: {
      name: string;
      query: (e: unknown, n: () => Promise<unknown>) => Promise<unknown>;
    }) {
      middlewares.push({ name: param.name, query: param.query });
    },
  };
}
