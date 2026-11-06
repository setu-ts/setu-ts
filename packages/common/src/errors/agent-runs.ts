/** Value-free errors shared by run services and stores. @module */
import { withHttpStatusHint } from './status-hint.ts';

/** Missing or inaccessible run; deliberately indistinguishable. @since 0.12.0 */
export class AgentRunNotFoundError extends Error {
  /** Stable error class name. */
  override readonly name = 'AgentRunNotFoundError';
  constructor() {
    super('Agent run not found.');
    withHttpStatusHint(this, { status: 404, title: 'Not Found', detail: 'Agent run not found.' });
  }
}
/** An action conflicts with the current state or input bound. @since 0.12.0 */
export class AgentRunStateError extends Error {
  /** Stable error class name. */
  override readonly name = 'AgentRunStateError';
  constructor(status: 409 | 413 = 409) {
    super('The agent run cannot accept this action.');
    withHttpStatusHint(this, {
      status,
      title: status === 413 ? 'Content Too Large' : 'Conflict',
      detail: 'The agent run cannot accept this action.',
    });
  }
}
/** Approval already decided, expired, or forbidden. @since 0.12.0 */
export class AgentRunApprovalError extends Error {
  /** Stable error class name. */
  override readonly name = 'AgentRunApprovalError';
  constructor(status: 409 | 403 = 409) {
    super('The approval cannot accept this decision.');
    withHttpStatusHint(this, {
      status,
      title: status === 403 ? 'Forbidden' : 'Conflict',
      detail: 'The approval cannot accept this decision.',
    });
  }
}
/** Definition configuration error, never served verbatim. @since 0.12.0 */
export class AgentRunDefinitionError extends Error {
  /** Stable error class name. */
  override readonly name = 'AgentRunDefinitionError';
  constructor(message = 'Invalid agent run definition.') {
    super(message);
  }
}
/** Internal fencing failure; the holder must stop immediately. @since 0.12.0 */
export class AgentRunLeaseLostError extends Error {
  /** Stable error class name. */
  override readonly name = 'AgentRunLeaseLostError';
  constructor() {
    super('Agent run lease lost.');
  }
}
/** Store capability or availability failure with a masked 503 hint. @since 0.12.0 */
export class AgentRunStoreUnavailableError extends Error {
  /** Stable error class name. */
  override readonly name = 'AgentRunStoreUnavailableError';
  /** Value-free code naming why the store refused, e.g. `conditional-writes-unsupported`. */
  readonly reason: string;
  constructor(reason: string, options?: ErrorOptions) {
    super('Agent run store unavailable.', options);
    this.reason = reason;
    withHttpStatusHint(this, {
      status: 503,
      title: 'Service Unavailable',
      detail: 'The agent run store is unavailable.',
    });
  }
}
