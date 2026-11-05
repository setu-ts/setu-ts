/**
 * Named vector-store errors, shared by the vector-store service and every
 * adapter (the Vectorize adapter lives in another plugin, so they live here).
 * A caller error carries a 400 status hint whose served detail never echoes the
 * request's values; the message, for logs, names the refused clause.
 *
 * @module
 */
import { withHttpStatusHint } from './status-hint.ts';

/**
 * Tenancy is required and the request has no tenant.
 *
 * @since 0.12.0
 */
export class VectorScopeRequiredError extends Error {
  /** Stable error discriminant. */
  override readonly name = 'VectorScopeRequiredError';

  /** @param message - Which call needed a scope */
  constructor(message = 'A tenant is required to use the vector store.') {
    super(message);
    withHttpStatusHint(this, {
      status: 400,
      title: 'Bad Request',
      detail: 'This request is not associated with a tenant.',
    });
  }
}

/**
 * A scope is empty, ill-formed, or longer than 64 UTF-8 bytes.
 *
 * @since 0.12.0
 */
export class VectorScopeInvalidError extends Error {
  /** Stable error discriminant. */
  override readonly name = 'VectorScopeInvalidError';

  /** @param message - What is wrong with the scope, never the scope itself */
  constructor(message: string) {
    super(message);
    withHttpStatusHint(this, {
      status: 400,
      title: 'Bad Request',
      detail: 'The vector-store scope is not valid.',
    });
  }
}

/**
 * A filter names an undeclared field, uses an operator its type does not
 * allow, or carries a value the store cannot match exactly.
 *
 * @since 0.12.0
 */
export class VectorFilterError extends Error {
  /** Stable error discriminant. */
  override readonly name = 'VectorFilterError';

  /** @param message - The refused clause, by field and operator */
  constructor(message: string) {
    super(message);
    withHttpStatusHint(this, {
      status: 400,
      title: 'Bad Request',
      detail: 'The search filter is not valid.',
    });
  }
}

/**
 * A vector has the wrong length, a non-finite component, or zero norm.
 *
 * @since 0.12.0
 */
export class VectorDimensionError extends Error {
  /** Stable error discriminant. */
  override readonly name = 'VectorDimensionError';

  /** @param message - What is wrong with the vector */
  constructor(message: string) {
    super(message);
    withHttpStatusHint(this, {
      status: 400,
      title: 'Bad Request',
      detail: 'The vector is not valid for this collection.',
    });
  }
}

/**
 * A record or a call's arguments break a limit: an id, content or metadata
 * value, a batch size, `topK` or `minScore`.
 *
 * @since 0.12.0
 */
export class VectorRecordError extends Error {
  /** Stable error discriminant. */
  override readonly name = 'VectorRecordError';

  /** @param message - Which limit was broken */
  constructor(message: string) {
    super(message);
    withHttpStatusHint(this, {
      status: 400,
      title: 'Bad Request',
      detail: 'The vector-store request is not valid.',
    });
  }
}

/**
 * A call names a collection the store was not configured with.
 *
 * @since 0.12.0
 */
export class VectorCollectionUnknownError extends Error {
  /** Stable error discriminant. */
  override readonly name = 'VectorCollectionUnknownError';

  /** @param collection - The undeclared name */
  constructor(collection: string) {
    super(
      `Vector collection '${collection}' is not declared in VectorStorePlugin({ collections }).`,
    );
    withHttpStatusHint(this, {
      status: 500,
      title: 'Internal Server Error',
      detail: 'The vector store is not configured for this request.',
    });
  }
}

/**
 * An existing collection does not match its declaration (dimensions or metric),
 * so the application refuses to start rather than mix incompatible vectors.
 *
 * @since 0.12.0
 */
export class VectorCollectionMismatchError extends Error {
  /** Stable error discriminant. */
  override readonly name = 'VectorCollectionMismatchError';

  /** @param message - The collection and the mismatch found */
  constructor(message: string) {
    super(message);
  }
}

/**
 * The backend cannot perform an operation or support a declaration, e.g.
 * deleting by scope on Vectorize, or more dimensions than it indexes.
 *
 * @since 0.12.0
 */
export class VectorOperationUnsupportedError extends Error {
  /** Stable error discriminant. */
  override readonly name = 'VectorOperationUnsupportedError';

  /** @param message - The backend and the operation */
  constructor(message: string) {
    super(message);
    withHttpStatusHint(this, {
      status: 501,
      title: 'Not Implemented',
      detail: 'The vector store does not support this operation.',
    });
  }
}
