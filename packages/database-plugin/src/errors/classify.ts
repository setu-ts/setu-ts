/**
 * The driver-error classifier (X38-1/X35-2, M90f).
 *
 * Backends carry their own machine-readable retry classifier — PostgreSQL
 * answers a serialization failure with SQLSTATE `40001`, the canonical
 * "this did not happen, run it again" — and before M90f the boundary
 * discarded it: the condition reached the client as a masked `500`, which by
 * convention means the opposite, so a well-behaved client did not retry and
 * the write was silently dropped. This module reads the classifier the
 * backend supplied and maps it onto the two statuses the framework answers
 * caller-actionable database conditions with.
 *
 * The signal table is per backend (§3.2 of the M90f plan). A **code** is
 * read first — SQLSTATE for the SQL backends, a gRPC status for Bigtable,
 * the Cosmos HTTP status — and driver **error names** and one **message
 * anchor** cover only the signals no code is carried on. Every anchor has a
 * real-backend test that fails if the driver's text changes, which is the
 * only thing that makes a message match safe.
 *
 * @module
 */
import { DatabaseUnavailableError, SerializationConflictError } from '../errors.ts';

/**
 * The two caller-actionable classes a driver error can be mapped onto.
 *
 * - `'conflict'` — the write was rejected because of concurrent work; the
 *   operation did not happen and **may be retried** (`409`).
 * - `'unavailable'` — the database, its pool, or its network is temporarily
 *   unreachable; the operation did not happen and **may be retried** (`503`).
 *
 * @since 0.5.0
 */
export type DriverErrorClass = 'conflict' | 'unavailable';

/**
 * The maximum number of `cause` hops the walk performs.
 *
 * A measured drizzle-orm cause chain is two deep (drizzle's own
 * `"Failed query: …"` wrapper, then the pg error carrying `code`); five
 * bounds the walk well past anything real while keeping it finite.
 */
const MAX_CAUSE_DEPTH = 5;

/** gRPC `ABORTED` — Bigtable's concurrency-conflict status. */
const GRPC_ABORTED = 10;

/** gRPC `UNAVAILABLE` — Bigtable's transient-unavailability status. */
const GRPC_UNAVAILABLE = 14;

/** Cosmos DB "Retry With" — a transient write conflict. */
const COSMOS_RETRY_WITH = 449;

/** Cosmos DB throttled — transient backpressure. */
const COSMOS_TOO_MANY_REQUESTS = 429;

/** Cosmos DB server-side unavailability. */
const COSMOS_UNAVAILABLE = 503;

/** SQLSTATE `57P03` — `cannot_connect_now`, refused by the server itself. */
const PG_CANNOT_CONNECT_NOW = '57P03';

/**
 * The node/net errno strings that mean "temporarily unreachable" (M90f).
 *
 * Measured against DynamoDB Local through the AWS SDK: a connect refusal
 * surfaces as the BARE net error — `name` still `"Error"`, but
 * `code: "ECONNREFUSED"` — so the SDK's own `TimeoutError`/`NetworkingError`
 * names never fire for the commonest outage shape. SQLSTATE strings are
 * digits, so no collision is possible with the class-40/class-08 arms.
 */
const UNAVAILABLE_ERRNOS: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
]);

/**
 * The message anchor for node-postgres pool exhaustion, which carries **no
 * code**: when `connectionTimeoutMillis` elapses the pool rejects with this
 * exact text. Pinned by the live-Drizzle guarded suite, which fails if the
 * driver's wording moves.
 */
const PG_POOL_TIMEOUT_ANCHOR = 'timeout exceeded when trying to connect';

/** The MongoDB error label marking a transaction conflict as retryable. */
const MONGO_TRANSIENT_TRANSACTION_ERROR = 'TransientTransactionError';

/**
 * Prisma's own code for a write conflict: it maps the backend's SQLSTATE
 * `40001`/`40P01` onto `P2034` ("Transaction failed due to a write conflict
 * or a deadlock") before the application sees it, so the SQLSTATE class arm
 * never fires through the Prisma adapter. Same signal, code-carried.
 */
const PRISMA_WRITE_CONFLICT = 'P2034';

/**
 * Classifies a driver error onto {@linkcode DriverErrorClass}, walking the
 * `cause` chain.
 *
 * The walk is **bounded and cycle-safe**, and both bounds are requirements
 * rather than defensive extras: a `cause` chain can be cyclic (an error
 * whose `cause` is itself, or a two-node loop) and a guarded read prevents a
 * throw, never a non-terminating loop — and the one `catch` whose job is to
 * contain a driver failure must not hang the request instead.
 *
 * An error this package already produced is reported as `null` — pass it
 * through untouched. `wrapDataSource` wraps the transaction-scoped data
 * source too, so an error already turned into a
 * {@linkcode SerializationConflictError} inside a repository call reaches
 * `transaction()`'s catch, where a second classification would wrap the
 * wrapper: the caller's `cause` would then be the first classified error
 * rather than the driver error the contract promises.
 *
 * @param error - The thrown value to classify
 * @returns The class, or `null` when no signal in the table matches
 * @since 0.5.0
 */
export function classifyDriverError(error: unknown): DriverErrorClass | null {
  // Errors this milestone already classified are final. Only the TOP-LEVEL
  // value is checked: walking INTO a classified error's cause could
  // re-classify from the driver error it wraps, which is exactly the
  // double-wrap the pass-through exists to prevent.
  if (error instanceof SerializationConflictError || error instanceof DatabaseUnavailableError) {
    return null;
  }

  const visited = new Set<unknown>();
  const candidates: DriverErrorMembers[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
    if (typeof current !== 'object' || current === null) break;
    if (visited.has(current)) break; // cyclic cause chain
    visited.add(current);
    const members = safeMembers(current);
    if (members !== undefined) {
      candidates.push(members);
    }
    current = causeOf(current);
  }

  // A code or label supplied by a driver is more authoritative than a
  // generic wrapper name or message. Search every cause first: an ORM may
  // wrap a SQLSTATE `40001` in an error named `TimeoutError`, and returning
  // 503 from that outer name would turn a retryable conflict into the wrong
  // caller contract.
  for (const members of candidates) {
    const matched = classifyStructured(members);
    if (matched !== null) return matched;
  }
  for (const members of candidates) {
    const matched = classifyFallback(members);
    if (matched !== null) return matched;
  }
  return null;
}

/**
 * The classifier fields read from one driver error.
 */
type DriverErrorMembers = {
  code: unknown;
  name: unknown;
  labels: readonly unknown[] | undefined;
  message: unknown;
};

/**
 * Classifies machine-readable driver signals.
 *
 * A code or Mongo label is a driver-supplied classifier, so it outranks names
 * and messages from wrappers elsewhere in the cause chain.
 */
function classifyStructured({ code, labels }: DriverErrorMembers): DriverErrorClass | null {
  // 1. A numeric code — gRPC (Bigtable) or the Cosmos HTTP status. Measured
  //    on a real server: a MongoServerError ALSO carries a numeric `code`
  //    (`112` WriteConflict) alongside its label, so an UNMATCHED numeric
  //    code vetoes nothing — the later structured arms still run.
  if (typeof code === 'number') {
    if (code === GRPC_ABORTED) return 'conflict';
    if (code === GRPC_UNAVAILABLE) return 'unavailable';
    if (code === COSMOS_RETRY_WITH) return 'conflict';
    if (code === COSMOS_TOO_MANY_REQUESTS || code === COSMOS_UNAVAILABLE) return 'unavailable';
  }

  // 2. A string code — SQLSTATE (or Prisma's mapping of it). Class `40` is
  //    "Transaction Rollback": every member (40001 serialization_failure,
  //    40P01 deadlock_detected) means the transaction rolled back and may be
  //    retried. Class `08` is "Connection Exception"; `57P03` is the server
  //    refusing connections. A matched string code is FINAL: SQLSTATE
  //    classes are the backend's own classifier and outrank any text.
  if (typeof code === 'string') {
    if (code === PG_CANNOT_CONNECT_NOW) return 'unavailable';
    if (code === PRISMA_WRITE_CONFLICT) return 'conflict';
    if (code.startsWith('40')) return 'conflict';
    if (code.startsWith('08')) return 'unavailable';
    if (UNAVAILABLE_ERRNOS.has(code)) return 'unavailable';
  }

  // 3. MongoDB carries its conflict signal as an error LABEL, not a code —
  //    measured on a real replica set: `code=112 codeName=WriteConflict,
  //    errorLabels=["TransientTransactionError"]`.
  if (labels?.includes(MONGO_TRANSIENT_TRANSACTION_ERROR)) return 'conflict';

  return null;
}

/**
 * Classifies fallback signals from errors that carried no machine-readable
 * driver signal anywhere in their cause chain.
 */
function classifyFallback({ name, message }: DriverErrorMembers): DriverErrorClass | null {
  // Driver error names, for the signals no code is carried on. These are
  //    `name` STRINGS, deliberately — the classifier sees foreign objects,
  //    not classes it could `instanceof`.
  if (typeof name === 'string') {
    if (name === 'TransactionConflictException') return 'conflict'; // DynamoDB
    if (name === 'MongoNetworkError' || name === 'MongoServerSelectionError') {
      return 'unavailable';
    }
    // The AWS SDK's own network failures. These names are generic, which is
    // why the code arms run first: a typed signal always wins over a name.
    if (name === 'TimeoutError' || name === 'NetworkingError') return 'unavailable';
  }

  // The one message anchor — node-postgres pool exhaustion, which carries
  //    no code at all. Reached last, only after every structured signal
  //    missed; pinned by a live-backend test.
  if (typeof message === 'string' && message.includes(PG_POOL_TIMEOUT_ANCHOR)) {
    return 'unavailable';
  }

  return null;
}

/**
 * Reads the four classifier members once, guarded, into locals.
 *
 * A `SyntaxError`-shaped getter on a hostile value reads as "no members"
 * rather than throwing into the error path.
 */
function safeMembers(
  value: object,
):
  | DriverErrorMembers
  | undefined {
  try {
    const candidate = value as {
      code?: unknown;
      name?: unknown;
      message?: unknown;
      errorLabels?: unknown;
    };
    return {
      code: candidate.code,
      name: candidate.name,
      message: candidate.message,
      labels: Array.isArray(candidate.errorLabels) ? candidate.errorLabels : undefined,
    };
  } catch {
    return undefined;
  }
}

/**
 * Reads one `cause` hop, guarded the same way.
 */
function causeOf(value: object): unknown {
  try {
    const candidate = value as { cause?: unknown };
    return candidate.cause;
  } catch {
    return undefined;
  }
}
