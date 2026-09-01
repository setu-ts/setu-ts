/**
 * The write buffer behind a Cosmos transaction.
 *
 * Cosmos has no interactive transaction. Its one unit of atomicity is a
 * transactional batch, which is scoped to ONE container and ONE partition-key
 * value and capped at 100 operations — all three measured, the second as a 400
 * and the third as an SDK refusal. So a Unit of Work buffers every write and
 * flushes the whole buffer as one batch at commit, the shape `D1Adapter`
 * established for a platform whose only atomicity is a pre-declared batch.
 *
 * The scope rules are enforced at the write that breaks them rather than at
 * commit, so a caller learns WHICH write left the batch's reach instead of
 * merely that the batch did.
 *
 * @module
 */
import type { CosmosBatchOperation, CosmosPartitionKeyValue } from './cosmos-client-types.ts';
import { CosmosTransactionScopeError } from '../../errors.ts';

/** The largest number of operations one transactional batch accepts. */
export const MAX_BATCH_OPERATIONS = 100;

/**
 * One buffered write, carrying the scope it was issued in so the buffer can
 * refuse a second container or partition-key value by name.
 *
 * @internal
 */
export interface BufferedWrite {
  /** The container the write targets. */
  readonly container: string;
  /** The partition-key value the write targets. */
  readonly partitionKey: CosmosPartitionKeyValue;
  /** The batch operation itself. */
  readonly operation: CosmosBatchOperation;
}

/**
 * Accumulates the writes of one Unit of Work and enforces the three bounds a
 * transactional batch has.
 *
 * @internal
 */
export class BatchBuffer {
  readonly #writes: BufferedWrite[] = [];

  /**
   * Buffers one write, refusing it when it leaves the batch's reach.
   *
   * @param write - The write to buffer
   * @throws {CosmosTransactionScopeError} When the write targets a second
   *   container, a second partition-key value, or would exceed the
   *   100-operation cap
   */
  add(write: BufferedWrite): void {
    const first = this.#writes[0];
    if (first !== undefined) {
      if (first.container !== write.container) {
        throw new CosmosTransactionScopeError(
          `A Cosmos transaction is one transactional batch, which cannot span containers: this ` +
            `unit of work already wrote to '${first.container}' and is now writing to ` +
            `'${write.container}'. Use one transaction per container.`,
        );
      }
      if (!samePartitionKey(first.partitionKey, write.partitionKey)) {
        throw new CosmosTransactionScopeError(
          `A Cosmos transaction is one transactional batch, which is atomic within a single ` +
            `partition-key value: this unit of work already wrote to partition ` +
            `${renderPartitionKey(first.partitionKey)} and is now writing to ` +
            `${renderPartitionKey(write.partitionKey)}.`,
        );
      }
    }
    // Exactly one pairing is lossy, and this rule is deliberately no wider than
    // it. A `Replace` carries a WHOLE document assembled from committed state,
    // so buffering one after any other write to the same item throws that
    // earlier write away and still answers 200 — measured against the emulator,
    // two such replaces answer `[200, 200]` with the first one's change gone.
    // Every other pairing composes and is allowed: two patches compose
    // (measured, `[set /a, set /b]` leaves both fields set), a patch after a
    // replace applies on top of it, and a delete after anything is unambiguous.
    const candidate = write.operation;
    if (
      candidate.operationType === 'Replace' &&
      this.#writes.some((buffered) => itemIdOf(buffered.operation) === candidate.id)
    ) {
      throw new CosmosTransactionScopeError(
        `A Cosmos transaction already writes to '${candidate.id}' in '${write.container}', and ` +
          'this update is too wide for a patch, so it is sent as a whole-document replace built ' +
          'from COMMITTED state — it would silently discard the earlier write. Merge the two ' +
          'updates into one, or use two transactions. (Narrower updates of the same row are sent ' +
          'as patches, which compose, and are allowed.)',
      );
    }
    if (this.#writes.length >= MAX_BATCH_OPERATIONS) {
      throw new CosmosTransactionScopeError(
        `A Cosmos transactional batch accepts at most ${MAX_BATCH_OPERATIONS} operations, and this ` +
          'unit of work has reached that limit. Split the work across several transactions.',
      );
    }
    this.#writes.push(write);
  }

  /**
   * Whether anything has been buffered.
   *
   * @returns `true` when the buffer holds no write
   */
  isEmpty(): boolean {
    return this.#writes.length === 0;
  }

  /**
   * The container every buffered write targets.
   *
   * @returns The container name, or `undefined` when the buffer is empty
   */
  container(): string | undefined {
    return this.#writes[0]?.container;
  }

  /**
   * The partition-key value every buffered write targets.
   *
   * @returns The value, or `undefined` when the buffer is empty
   */
  partitionKey(): CosmosPartitionKeyValue | undefined {
    return this.#writes[0]?.partitionKey;
  }

  /**
   * The buffered operations, in the order they were issued.
   *
   * @returns The operations to send as one batch
   */
  operations(): readonly CosmosBatchOperation[] {
    return this.#writes.map((write) => write.operation);
  }

  /** Discards every buffered write, so a rollback sends nothing. */
  clear(): void {
    this.#writes.length = 0;
  }
}

/**
 * The document id one batch operation addresses, when it names one.
 *
 * A `Create` mints its id at the service unless the body carries one, so the
 * body is consulted before the operation's own `id`.
 *
 * @param operation - The batch operation
 * @returns The id, or `undefined` when the operation names none
 * @since 0.2.0
 */
export function itemIdOf(operation: CosmosBatchOperation): string | undefined {
  if (operation.operationType === 'Delete' || operation.operationType === 'Patch') {
    return operation.id;
  }
  const fromBody = operation.resourceBody['id'];
  return typeof fromBody === 'string' ? fromBody : operation.id;
}

/**
 * Compares two partition-key values, including the element-wise comparison a
 * hierarchical key needs.
 *
 * @param left - The first value
 * @param right - The second value
 * @returns `true` when both address the same partition
 * @since 0.2.0
 */
export function samePartitionKey(
  left: CosmosPartitionKeyValue,
  right: CosmosPartitionKeyValue,
): boolean {
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    return left.length === right.length && left.every((value, index) => value === right[index]);
  }
  return left === right;
}

/**
 * Renders a partition-key value for a diagnostic message.
 *
 * @param value - The partition-key value
 * @returns A readable rendering
 * @since 0.2.0
 */
export function renderPartitionKey(value: CosmosPartitionKeyValue): string {
  return JSON.stringify(value) ?? String(value);
}
