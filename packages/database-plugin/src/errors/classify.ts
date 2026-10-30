/**
 * The driver-error classifier (X38-1/X35-2, M90f).
 *
 * Backends carry their own machine-readable retry classifier — PostgreSQL
 * answers a serialization failure with SQLSTATE `40001`, the canonical
 * "this did not happen, run it again" — and before M90f the boundary
 * discarded it: the condition reached the client as a masked `500`, which by
 * convention means the opposite, so a well-behaved client did not retry and
 * the write was silently dropped. This module reads the classifier the
 * backend supplied and maps it onto the statuses the framework answers
 * caller-actionable database conditions with. A duplicate key, the third
 * class, was masked the same way and is read from the same table.
 *
 * The signal table is per backend (§3.2 of the M90f plan). A **code** is
 * read first — SQLSTATE for the SQL backends, a gRPC status for Bigtable,
 * the Cosmos HTTP status — and driver **error names** and **message
 * anchors** cover the remaining signals. Every anchor has a
 * real-backend test that fails if the driver's text changes, which is the
 * only thing that makes a message match safe.
 *
 * @module
 */
import { isConnectionFaultCode, DuplicateKeyError } from '@setu-ts/common';
import {
  DatabaseTimeoutError,
  DatabaseUnavailableError,
  SerializationConflictError,
} from '../errors.ts';
import type { DatabaseAdapterType } from '../interfaces/index.ts';

/**
 * The caller-actionable classes a driver error can be mapped onto.
 *
 * - `'conflict'` — the write was rejected because of concurrent work; the
 *   operation did not happen and **may be retried** (`409`).
 * - `'unavailable'` — the database, its pool, or its network is temporarily
 *   unreachable; the operation did not happen and **may be retried** (`503`).
 * - `'duplicate'` — the write would duplicate a primary key or a unique
 *   index; the operation did not happen and repeating it fails the same way
 *   (`409`).
 * - `'timeout'` — the driver call bound elapsed; a write's outcome is
 *   unknown and retries must be idempotent (`504`).
 *
 * @since 0.5.0
 */
export type DriverErrorClass = 'conflict' | 'unavailable' | 'duplicate' | 'timeout';

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

/** MongoDB's duplicate-key code (`E11000`), measured on a real server. */
const MONGO_DUPLICATE_KEY = 11000;

/** Cosmos DB `409` — an existing `id` in the partition, or a unique-key violation. */
const COSMOS_CONFLICT = 409;

/**
 * The string codes that mean "duplicate key": PostgreSQL SQLSTATE `23505`
 * (`unique_violation`), Prisma's `P2002` (its own mapping of that SQLSTATE,
 * measured through the Prisma 7 pg driver adapter), and mysql2's
 * `ER_DUP_ENTRY`. PostgreSQL and Prisma are pinned by the guarded live
 * suites; `ER_DUP_ENTRY` was measured against MySQL 8 by probe, since CI runs
 * no MySQL.
 */
const DUPLICATE_KEY_CODES: ReadonlySet<string> = new Set(['23505', 'P2002', 'ER_DUP_ENTRY']);

/**
 * The message anchor for SQLite's unique violation, which is the only signal
 * Cloudflare D1 carries: measured on workerd's local D1, the error has no
 * code and reads `D1_ERROR: UNIQUE constraint failed: a.id: SQLITE_CONSTRAINT
 * (extended: SQLITE_CONSTRAINT_PRIMARYKEY)`. The same words open
 * `node:sqlite`'s message and the SQLite drivers Drizzle supports, for a
 * primary key and a unique index alike.
 */
const SQLITE_UNIQUE_ANCHOR = 'UNIQUE constraint failed:';

/** SQLSTATE `57P03` — `cannot_connect_now`, refused by the server itself. */
const PG_CANNOT_CONNECT_NOW = '57P03';

/**
 * The message anchor for node-postgres pool exhaustion, which carries **no
 * code**: when `connectionTimeoutMillis` elapses the pool rejects with this
 * exact text. Pinned by the live-Drizzle guarded suite, which fails if the
 * driver's wording moves.
 */
const PG_POOL_TIMEOUT_ANCHOR = 'timeout exceeded when trying to connect';
/** pg-pool bounds a new connection handshake separately from pool waiting. */
const PG_NEW_CONNECTION_TIMEOUT_ANCHOR = 'Connection terminated due to connection timeout';
/** Client-side pg query bound; the statement may already have run. */
const PG_QUERY_TIMEOUT_ANCHOR = 'Query read timeout';

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
export function classifyDriverError(
  error: unknown,
  adapterType?: DatabaseAdapterType,
): DriverErrorClass | null {
  // Errors this milestone already classified are final. Only the TOP-LEVEL
  // value is checked: walking INTO a classified error's cause could
  // re-classify from the driver error it wraps, which is exactly the
  // double-wrap the pass-through exists to prevent.
  if (
    error instanceof SerializationConflictError ||
    error instanceof DatabaseUnavailableError ||
    error instanceof DatabaseTimeoutError ||
    error instanceof DuplicateKeyError
  ) {
    return null;
  }

  const candidates = causeChainMembers(error);

  // A code or label supplied by a driver is more authoritative than a
  // generic wrapper name or message. Search every cause first: an ORM may
  // wrap a SQLSTATE `40001` in an error named `TimeoutError`, and returning
  // 503 from that outer name would turn a retryable conflict into the wrong
  // caller contract.
  for (const members of candidates) {
    const matched = classifyStructured(members, adapterType);
    if (matched !== null) return matched;
  }
  const hasStringCode = candidates.some(({ code }) => typeof code === 'string');
  for (const members of candidates) {
    const matched = classifyFallback(members, classifyPgTimeout(members.message, hasStringCode));
    if (matched !== null) return matched;
  }
  return null;
}

/**
 * Whether node-postgres timed out waiting for a pool client, a new
 * connection handshake, or a query answer.
 *
 * Internal. The Drizzle reachability probe uses it to tell "every connection
 * is unanswered" from "the database refused": timeouts are rethrown, so the
 * service reports `undefined` rather than `false`. It matches the same
 * message anchors {@linkcode classifyDriverError} uses, over the same bounded,
 * cycle-safe cause walk, so the two cannot disagree about an unanswered call.
 *
 * @param error - The thrown value
 * @returns `true` when any error in the cause chain carries a timeout anchor
 */
export function isUnansweredConnect(error: unknown): boolean {
  const candidates = causeChainMembers(error);
  const hasStringCode = candidates.some(({ code }) => typeof code === 'string');
  return candidates.some(({ message }) => classifyPgTimeout(message, hasStringCode) !== null);
}

/** The class 22 codes a supplied value can cause; see {@linkcode isValueTypeRefusal}. */
const VALUE_REFUSAL_CODES: ReadonlySet<string> = new Set(['22P02', '22003', '22007', '22008']);

/**
 * Whether the database refused a supplied value as the wrong type for its
 * column: one of the four SQLSTATE class 22 codes a supplied value can cause
 * (`22P02` invalid text representation, `22003` numeric value out of range,
 * `22007` invalid datetime format, `22008` datetime field overflow) anywhere
 * in the cause chain, or Prisma's client-side `PrismaClientValidationError`,
 * which Prisma raises before any SQL for a value its schema does not accept.
 * Other class 22 codes (division by zero, `22012`) are data faults the server
 * computes, not a refused input (M113g audit round 3, L5).
 *
 * Internal. The Drizzle and Prisma keyset pages use it to answer a forged,
 * well-formed cursor carrying a mistyped value with `InvalidCursorError`
 * instead of a masked `500` (M113g, plan §3.5a). Reads go through the same
 * bounded, guarded cause walk as the classifier.
 *
 * @param error - The thrown value
 * @returns `true` when the backend rejected a value's type
 */
export function isValueTypeRefusal(error: unknown): boolean {
  return causeChainMembers(error).some(
    ({ code, name }) =>
      (typeof code === 'string' && VALUE_REFUSAL_CODES.has(code)) ||
      name === 'PrismaClientValidationError',
  );
}

/**
 * PostgreSQL or Prisma refused repository input, separate from transient classification.
 * @param error - The thrown driver rejection
 * @returns The input refusal, or null for other driver conditions
 * @since 0.11.0
 */
export function refusedInputOf(
  error: unknown,
): { kind: 'unknown-field'; field: string } | { kind: 'value' } | null {
  const candidates = causeChainMembers(error);
  for (const { name, message } of candidates) {
    if (name === 'PrismaClientValidationError' && typeof message === 'string') {
      // Prisma renders the whole invocation, payload values included, above
      // its summary line, so only a match that STARTS a line is Prisma's own:
      // a rendered value sits indented after its key, and its newlines are
      // escaped. The last such line wins (M119e audit F-2).
      const field = [...message.matchAll(/^Unknown argument `([^`]+)`/gm)].at(-1)?.[1];
      if (field !== undefined) return { kind: 'unknown-field', field };
    }
  }
  return candidates.some(
    ({ code, name }) =>
      (typeof code === 'string' && VALUE_REFUSAL_CODES.has(code)) ||
      name === 'PrismaClientValidationError' ||
      // P2007 is the measured code for a value the database refused (Prisma
      // 7.10.1, malformed uuid). P2023 is not mapped: Prisma also raises it for
      // stored data it cannot read, which is a server fault, not caller input.
      (name === 'PrismaClientKnownRequestError' && code === 'P2007'),
  )
    ? { kind: 'value' }
    : null;
}

/**
 * Replace Prisma's query-rendering diagnostic with a value-free refusal cause.
 * Internal; other drivers retain the service's existing scrubber.
 * @param error - The thrown driver rejection
 * @returns A fresh diagnostic carrying only Prisma's name and code, when present
 */
export function prismaRefusalCause(error: unknown): Error | undefined {
  const prisma = causeChainMembers(error).find(
    ({ name }) =>
      name === 'PrismaClientValidationError' || name === 'PrismaClientKnownRequestError',
  );
  if (prisma === undefined) return undefined;
  const code = typeof prisma.code === 'string' ? ` ${prisma.code}` : '';
  return Object.assign(new Error(`Prisma refused the input (${String(prisma.name)}${code}).`), {
    name: String(prisma.name),
  });
}

/** Fixed pg timeout messages are authoritative only on a chain without string codes. */
function classifyPgTimeout(
  message: unknown,
  hasStringCode: boolean,
): 'unavailable' | 'timeout' | null {
  if (hasStringCode) return null;
  if (message === PG_POOL_TIMEOUT_ANCHOR || message === PG_NEW_CONNECTION_TIMEOUT_ANCHOR) {
    return 'unavailable';
  }
  if (message === PG_QUERY_TIMEOUT_ANCHOR) return 'timeout';
  return null;
}

/**
 * The objects of a cause chain — the error itself, then each `cause` hop —
 * bounded by `MAX_CAUSE_DEPTH` and stopping at a cycle or at a non-object.
 *
 * The one cause walk in this package: the classifier reads it, and so does the
 * outbox bridge's startup check, so the two cannot disagree about how deep a
 * driver signal may sit or what a cyclic chain is.
 *
 * @param error - The thrown value
 * @returns The chain's objects, outermost first
 */
export function causeChain(error: unknown): object[] {
  const visited = new Set<unknown>();
  const chain: object[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
    if (typeof current !== 'object' || current === null) break;
    if (visited.has(current)) break; // cyclic cause chain
    visited.add(current);
    chain.push(current);
    current = causeOf(current);
  }
  return chain;
}

/**
 * Reads the classifier members of every error in a cause chain.
 */
function causeChainMembers(error: unknown): DriverErrorMembers[] {
  const candidates: DriverErrorMembers[] = [];
  for (const member of causeChain(error)) {
    const members = safeMembers(member);
    if (members !== undefined) {
      candidates.push(members);
    }
  }
  return candidates;
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
function classifyStructured(
  { code, labels }: DriverErrorMembers,
  adapterType: DatabaseAdapterType | undefined,
): DriverErrorClass | null {
  // 1. Numeric codes have backend-local namespaces: Mongo's `10` means
  //    CannotMutateObject while Bigtable's gRPC `10` means ABORTED. Only read
  //    them when the active adapter identifies the namespace. An unmatched
  //    numeric code still does not veto the Mongo label below.
  if (typeof code === 'number') {
    if (adapterType === 'mongodb' && code === MONGO_DUPLICATE_KEY) return 'duplicate';
    if (adapterType === 'bigtable') {
      if (code === GRPC_ABORTED) return 'conflict';
      if (code === GRPC_UNAVAILABLE) return 'unavailable';
    }
    if (adapterType === 'cosmos') {
      if (code === COSMOS_RETRY_WITH) return 'conflict';
      if (code === COSMOS_CONFLICT) return 'duplicate';
      if (code === COSMOS_TOO_MANY_REQUESTS || code === COSMOS_UNAVAILABLE) return 'unavailable';
    }
  }

  // 2. A string code — SQLSTATE (or Prisma's mapping of it). The whitelisted
  //    `40001` and `40P01` states mean the transaction rolled back and may be
  //    retried. Other class-40 states, including `40003` completion-unknown,
  //    do not establish that outcome and stay masked. Class `08` is
  //    "Connection Exception"; `57P03` is the server
  //    refusing connections. A matched string code is FINAL: SQLSTATE
  //    classes are the backend's own classifier and outrank any text.
  if (typeof code === 'string') {
    if (DUPLICATE_KEY_CODES.has(code)) return 'duplicate';
    if (code === PG_CANNOT_CONNECT_NOW) return 'unavailable';
    if (code === PRISMA_WRITE_CONFLICT) return 'conflict';
    if (code === '40001' || code === '40P01') return 'conflict';
    if (code.startsWith('08')) return 'unavailable';
    // A bare net error (e.g. DynamoDB Local refusing a connection) carries
    // errno rather than the SDK's TimeoutError/NetworkingError name.
    if (isConnectionFaultCode(code)) return 'unavailable';
  }

  // 3. MongoDB carries its conflict signal as an error LABEL, not a code —
  //    measured on a real replica set: `code=112 codeName=WriteConflict,
  //    errorLabels=["TransientTransactionError"]`.
  if (labels?.includes(MONGO_TRANSIENT_TRANSACTION_ERROR)) return 'conflict';

  return null;
}

/**
 * Classifies fallback signals after no structured rule matched the cause chain.
 */
function classifyFallback(
  { name, message }: DriverErrorMembers,
  pgTimeout: 'unavailable' | 'timeout' | null,
): DriverErrorClass | null {
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

  // Message anchors — node-postgres connection/query timeouts and SQLite's
  //    unique violation. SQLite may carry ERR_SQLITE_ERROR. Reached last, only
  //    after every structured signal missed; each is pinned by a test against
  //    the real engine.
  if (pgTimeout !== null) return pgTimeout;
  if (typeof message === 'string') {
    if (
      message.startsWith(SQLITE_UNIQUE_ANCHOR) ||
      message.startsWith(`D1_ERROR: ${SQLITE_UNIQUE_ANCHOR}`)
    )
      return 'duplicate';
  }

  return null;
}

/**
 * Reads the four classifier members once, guarded, into locals.
 *
 * A `SyntaxError`-shaped getter on a hostile value reads as "no members"
 * rather than throwing into the error path.
 */
function safeMembers(value: object): DriverErrorMembers | undefined {
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
