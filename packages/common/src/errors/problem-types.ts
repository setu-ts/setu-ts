/** Stable database problem identities. See docs/problem-types.md. @module */

/** Canonical base URI for framework problem types. @since 0.14.0 */
export const ERROR_TYPE_BASE = 'https://setu-ts.dev/errors';

/** Database conditions and their client-facing titles. See docs/problem-types.md. @since 0.14.0 */
export const DATABASE_PROBLEM_TYPES: {
  readonly 'write-conflict': {
    readonly type: `${typeof ERROR_TYPE_BASE}/write-conflict`;
    readonly title: 'Write Conflict';
  };
  readonly 'lock-timeout': {
    readonly type: `${typeof ERROR_TYPE_BASE}/lock-timeout`;
    readonly title: 'Lock Timeout';
  };
  readonly 'version-conflict': {
    readonly type: `${typeof ERROR_TYPE_BASE}/version-conflict`;
    readonly title: 'Version Conflict';
  };
  readonly 'duplicate-key': {
    readonly type: `${typeof ERROR_TYPE_BASE}/duplicate-key`;
    readonly title: 'Duplicate Key';
  };
  readonly 'foreign-key-violation': {
    readonly type: `${typeof ERROR_TYPE_BASE}/foreign-key-violation`;
    readonly title: 'Foreign Key Violation';
  };
  readonly 'not-null-violation': {
    readonly type: `${typeof ERROR_TYPE_BASE}/not-null-violation`;
    readonly title: 'Not Null Violation';
  };
  readonly 'invalid-field-value': {
    readonly type: `${typeof ERROR_TYPE_BASE}/invalid-field-value`;
    readonly title: 'Invalid Field Value';
  };
  readonly 'database-unavailable': {
    readonly type: `${typeof ERROR_TYPE_BASE}/database-unavailable`;
    readonly title: 'Database Unavailable';
  };
  readonly 'database-pool-saturated': {
    readonly type: `${typeof ERROR_TYPE_BASE}/database-pool-saturated`;
    readonly title: 'Database Pool Saturated';
  };
  readonly 'database-timeout': {
    readonly type: `${typeof ERROR_TYPE_BASE}/database-timeout`;
    readonly title: 'Database Timeout';
  };
  readonly 'database-connection-lost': {
    readonly type: `${typeof ERROR_TYPE_BASE}/database-connection-lost`;
    readonly title: 'Database Connection Lost';
  };
} = Object.freeze({
  'write-conflict': Object.freeze({
    type: `${ERROR_TYPE_BASE}/write-conflict`,
    title: 'Write Conflict',
  }),
  'lock-timeout': Object.freeze({ type: `${ERROR_TYPE_BASE}/lock-timeout`, title: 'Lock Timeout' }),
  'version-conflict': Object.freeze({
    type: `${ERROR_TYPE_BASE}/version-conflict`,
    title: 'Version Conflict',
  }),
  'duplicate-key': Object.freeze({
    type: `${ERROR_TYPE_BASE}/duplicate-key`,
    title: 'Duplicate Key',
  }),
  'foreign-key-violation': Object.freeze({
    type: `${ERROR_TYPE_BASE}/foreign-key-violation`,
    title: 'Foreign Key Violation',
  }),
  'not-null-violation': Object.freeze({
    type: `${ERROR_TYPE_BASE}/not-null-violation`,
    title: 'Not Null Violation',
  }),
  'invalid-field-value': Object.freeze({
    type: `${ERROR_TYPE_BASE}/invalid-field-value`,
    title: 'Invalid Field Value',
  }),
  'database-unavailable': Object.freeze({
    type: `${ERROR_TYPE_BASE}/database-unavailable`,
    title: 'Database Unavailable',
  }),
  'database-pool-saturated': Object.freeze({
    type: `${ERROR_TYPE_BASE}/database-pool-saturated`,
    title: 'Database Pool Saturated',
  }),
  'database-timeout': Object.freeze({
    type: `${ERROR_TYPE_BASE}/database-timeout`,
    title: 'Database Timeout',
  }),
  'database-connection-lost': Object.freeze({
    type: `${ERROR_TYPE_BASE}/database-connection-lost`,
    title: 'Database Connection Lost',
  }),
});
