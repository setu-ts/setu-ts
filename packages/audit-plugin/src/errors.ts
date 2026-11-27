/** Audit storage refusals. @module */

/** A storage backend cannot roll back with the caller's transaction. @since 0.14.0 */
export class AuditScopeUnsupportedError extends Error {
  /** Stable error discriminant. */
  override readonly name = 'AuditScopeUnsupportedError';

  /** Builds a value-free refusal before the storage writes anything. */
  constructor() {
    super(
      'This audit storage does not support transactional scopes; use database storage or omit the scope.',
    );
  }
}
