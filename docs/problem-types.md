# Database problem types

A status alone does not tell a client what to do. Several different refusals use 409. With
`errorHandler({ format: 'rfc9457' })` (or the older `rfc7807`, which writes the same body), use the
Problem Details `type` to distinguish them. The `default` error format has no `type` and ignores
problem metadata.

The base is `https://setu-ts.dev/errors`, exported as `ERROR_TYPE_BASE` from `@setu-ts/common`. Each
slug below identifies `https://setu-ts.dev/errors/<slug>`. A type URI is an identifier; it need not
resolve to a web page. `DATABASE_PROBLEM_TYPES` holds the eleven entries and their titles. The table
and each entry are frozen at runtime.

| Slug / Problem Details title                          | Status | Class and reason                                         | Meaning and client action                                                                                                                                         |
| ----------------------------------------------------- | ------ | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `write-conflict` / Write Conflict                     | 409    | `SerializationConflictError`, `reason: 'write-conflict'` | Concurrent work rejected the write. Retry the whole transaction as is, with backoff.                                                                              |
| `lock-timeout` / Lock Timeout                         | 409    | `SerializationConflictError`, `reason: 'lock-timeout'`   | The write could not acquire a lock in time. Retry the transaction as is, with backoff.                                                                            |
| `version-conflict` / Version Conflict                 | 409    | `VersionConflictError`; no reason field                  | The stored version differs from the version read. Reload, reconcile the change, then retry with the new version.                                                  |
| `duplicate-key` / Duplicate Key                       | 409    | `DuplicateKeyError`; no reason field                     | A unique key already exists. Change the input or use the existing record. Repeating the same insert is not a conflict retry.                                      |
| `foreign-key-violation` / Foreign Key Violation       | 409    | `ForeignKeyViolationError`; no reason field              | A referenced record is missing, or another record still refers to one being removed. Change the input or satisfy the relationship first.                          |
| `not-null-violation` / Not Null Violation             | 400    | `NotNullViolationError`; no reason field                 | A required field has no value. Supply it before retrying.                                                                                                         |
| `invalid-field-value` / Invalid Field Value           | 400    | `InvalidFieldValueError`; no reason field                | A repository value has the wrong type, format, length or range. Change the input.                                                                                 |
| `database-unavailable` / Database Unavailable         | 503    | `DatabaseUnavailableError`, `reason: 'unreachable'`      | The database or its connection could not serve the call. Back off and retry when it is available; see the network-signal limitation below before retrying writes. |
| `database-pool-saturated` / Database Pool Saturated   | 503    | `DatabaseUnavailableError`, `reason: 'pool-saturated'`   | pg-pool timed out waiting for a client. The request was not applied. Back off, then retry as is.                                                                  |
| `database-timeout` / Database Timeout                 | 504    | `DatabaseTimeoutError`, `reason: 'bound'`                | A driver or SDK call timed out. A write may have run. Its outcome is unknown: retry only idempotently or reconcile the stored result first.                       |
| `database-connection-lost` / Database Connection Lost | 504    | `DatabaseTimeoutError`, `reason: 'connection-lost'`      | The connection closed before the call completed. The write outcome is unknown: retry only idempotently or reconcile it first.                                     |

`DuplicateKeyError` and `InvalidFieldValueError` come from `@setu-ts/common`. The other classes come
from `@setu-ts/database-plugin`. The `reason` fields are on errors in application code; they select
the problem type and are not separate fields in the HTTP body.

For example, a version mismatch on `PUT /items/42` under `rfc9457` is:

```json
{
  "type": "https://setu-ts.dev/errors/version-conflict",
  "title": "Version Conflict",
  "status": 409,
  "detail": "The record was changed after it was read. Reload it and try again.",
  "instance": "/items/42"
}
```

Details are fixed sentences. They contain no driver text, bound values, keys or field values.
Changing the response format does not change the error class or its status hint.

These types do not cause an automatic retry. Bound attempts in the caller and use backoff for
transient failures. A timeout response does not undo an already committed write. No classified
database error adds `Retry-After`.

**Network-signal limitation:** bare `ECONNRESET`, `EPIPE` and `MongoNetworkError` still map to 503
even when a connection was lost during a write. This includes bare Cosmos socket errors. In that
case the status cannot establish that nothing was applied; retry only idempotently. DynamoDB's SDK
renames these socket failures to `TimeoutError`, which maps to 504. See the
[database driver signal table](../packages/database-plugin/README.md#what-a-driver-condition-returns-to-the-client).

Raw `query()` and native transaction work do not turn field-value refusals into 400: those mappings
need a repository entity. Commit-time unavailable and timeout errors are not reclassified, because
the commit outcome can be unknown. The types describe classified errors, not every possible driver
rejection. See [upgrading](upgrading.md) for the application changes.
