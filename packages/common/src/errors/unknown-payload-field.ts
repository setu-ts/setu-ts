/** Portable unknown payload field refusal. @module */
import { withHttpStatusHint } from './status-hint.ts';

/**
 * A write names a field absent from the entity's schema. The write was refused.
 * Diagnostics name the entity and field; the HTTP detail discloses neither.
 *
 * @example
 * ```typescript
 * if (error instanceof UnknownPayloadFieldError) {
 *   // Pick the resource's known fields before submitting the payload again.
 * }
 * ```
 * @since 0.11.0
 */
export class UnknownPayloadFieldError extends Error {
  /** Stable error discriminant. */
  override readonly name = 'UnknownPayloadFieldError';

  /**
   * @param entity - The addressed entity
   * @param field - The unknown payload field
   */
  constructor(entity: string, field: string, options?: ErrorOptions) {
    super(`Entity '${entity}' has no payload field ${renderDiagnosticName(field)}.`, options);
    withHttpStatusHint(this, {
      status: 400,
      title: 'Bad Request',
      detail: 'The request names a field this resource does not have.',
    });
  }
}

/**
 * Bounded, single-line rendering for caller-chosen names in diagnostics.
 *
 * Takes `unknown` because a JavaScript caller may forward a JSON value where a
 * field name is typed: a non-string renders as its type rather than throwing
 * (M113g audit round 3, L7).
 */
function renderDiagnosticName(name: unknown): string {
  if (typeof name !== 'string') return `<${name === null ? 'null' : typeof name}>`;
  return `${JSON.stringify(name.slice(0, 64))}${name.length > 64 ? '…' : ''}`;
}
