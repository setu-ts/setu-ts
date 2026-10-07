/**
 * The portable duplicate-key error.
 *
 * Every database backend refuses a write that would duplicate a primary key
 * or a unique index, and each says so differently: PostgreSQL SQLSTATE
 * `23505`, Prisma `P2002`, MySQL `ER_DUP_ENTRY`, MongoDB code `11000`, Cosmos
 * `409`, SQLite and Cloudflare D1 `UNIQUE constraint failed`, and the
 * memory, DynamoDB and Bigtable adapters with messages of their own. None of
 * those carries a status, so before this class each reached `errorHandler` as
 * a plain `Error` and was answered as a masked `500`, which tells the caller
 * that the server failed when it was the caller's write that collided.
 *
 * The class lives in `common` rather than in `@setu-ts/database-plugin`
 * because more than one package must produce or recognize it and §2.2 forbids
 * a plugin importing another plugin: an adapter outside the database plugin
 * (`@setu-ts/cloudflare-plugin`'s D1 adapter) and a consumer that records
 * "already processed" with a unique insert (an inbox or an idempotency store)
 * both need the one class.
 *
 * @module
 */
import { withHttpStatusHint } from './status-hint.ts';

/**
 * Thrown when a write would duplicate a primary key or a unique index.
 *
 * The write did **not** happen, and repeating it unchanged fails the same
 * way: unlike a serialization conflict this is not a retryable condition.
 * The response is `409 Conflict` with a fixed `detail`; the driver error is
 * kept as `cause` for the log and never served, because a driver message can
 * quote the duplicated value (PostgreSQL's `detail` reads
 * `Key (email)=(…) already exists`).
 *
 * @example
 * ```typescript
 * import { DuplicateKeyError } from '@setu-ts/common';
 *
 * try {
 *   await repository.create({ id: 'u1', email: 'ada@example.com' });
 * } catch (error) {
 *   if (error instanceof DuplicateKeyError) {
 *     // A row with that key or unique value already exists.
 *   }
 * }
 * ```
 *
 * @since 0.9.0
 */
export class DuplicateKeyError extends Error {
  /** Discriminant for consumers that cannot use `instanceof` across realms. */
  override readonly name = 'DuplicateKeyError';

  /**
   * The entity the write targeted, when the producer knows it. A refusal
   * raised at transaction commit, where several entities may be written at
   * once, carries none.
   */
  readonly entity: string | undefined;

  /**
   * Builds the error. The `message` is the full diagnostic, safe to log and
   * never served.
   *
   * @param message - The full diagnostic
   * @param options - The entity the write targeted, and the driver error as `cause`
   */
  constructor(message: string, options?: { entity?: string; cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.entity = options?.entity;
    withHttpStatusHint(this, {
      status: 409,
      title: 'Conflict',
      detail:
        'A record with the same unique key already exists. The conflicting write was rejected.',
    });
  }
}
