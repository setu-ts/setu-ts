/**
 * Marks an Error as originating from a transport settlement operation
 * (complete/ack or abandon/nack) so outer handlers can distinguish it from
 * handler invocation failures and avoid double-settlement.
 *
 * @module
 */

/**
 * WeakSet that tracks errors which originated from a transport settlement call.
 * Using a WeakSet preserves the original Error identity — no wrapping occurs.
 */
export const settlementErrors = new WeakSet<Error>();
