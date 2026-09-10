/**
 * How a REFUSED request body — as opposed to a malformed one — is reported to
 * a GraphQL client.
 *
 * Since M90a a body read can reject rather than return: `RuntimePlugin`'s
 * `maxBodyBytes` bounds it and rejects with a `RequestBodyTooLargeError`
 * branded with a `413` status hint. Both transports wrapped that read in a
 * `try` whose `catch` reported `400 INVALID_JSON`, which names the wrong
 * cause and the wrong remedy: the body was never parsed, so it was never
 * invalid, and a client told its JSON is bad will re-send the same oversized
 * document (V5-1).
 *
 * One module rather than a copy per transport: the HTTP handler and the SSE
 * handler build different response shapes but must agree on the STATUS and
 * the code, and duplicating the mapping is how they would come to disagree.
 *
 * @module
 */
import { httpStatusHintOf, MalformedRequestBodyError } from '@setu-ts/common';

/** HTTP status for a payload the server declined to read. */
const PAYLOAD_TOO_LARGE = 413;

/** How a refused body should be reported, in GraphQL's error vocabulary. */
export interface BodyRefusal {
  /** The status the thrower asked for, taken from its hint. */
  readonly status: number;
  /** The caller-facing sentence, served verbatim from the hint's `detail`. */
  readonly message: string;
  /** `extensions.code`, so a client can branch without parsing prose. */
  readonly code: string;
}

/**
 * Classifies a body-read rejection.
 *
 * A hinted error was refused deliberately by the framework and carries a
 * caller-safe sentence; anything else is an ordinary parse failure and keeps
 * the transport's existing `400`.
 *
 * A malformed body is deliberately NOT a refusal here, and that exclusion is
 * measured rather than defensive: since M90f `parseJsonBody` rejects with a
 * `MalformedRequestBodyError` that is ITSELF status-hinted, at `400`. Treating
 * every hinted rejection as a refusal therefore replaced the published
 * `INVALID_JSON` code with a generic one on the commonest failure of all —
 * caught by this file's own end-to-end test, which drives a genuinely
 * malformed body through a real app. The transports keep their own `400`
 * answer for that case, whose GraphQL-specific code says strictly more than
 * a generic hint can.
 *
 * @param error - The value the body read rejected with
 * @returns The refusal to report, or `null` when this was not a refusal
 * @since 0.6.0
 */
export function bodyRefusalOf(error: unknown): BodyRefusal | null {
  // `instanceof` first, then the `name` discriminant the class documents for
  // consumers that cannot use it — two copies of `@setu-ts/common` in one
  // process is precisely the case the hint's `Symbol.for` key survives, so
  // the classifier reading that hint should survive it too.
  if (isMalformedBody(error)) {
    return null;
  }
  const hint = httpStatusHintOf(error);
  if (hint === undefined) {
    return null;
  }
  return {
    status: hint.status,
    message: hint.detail,
    // 413 is the only hinted rejection this read can produce today, and it
    // gets the specific code the rest of this plugin's vocabulary would lead a
    // client to expect. The generic arm is not speculative padding: the hint
    // is a `Symbol.for` brand any package can attach, and a status this
    // mapping has never seen must still reach the client as SOMETHING it can
    // branch on rather than as a mislabelled size error.
    code: hint.status === PAYLOAD_TOO_LARGE ? 'REQUEST_BODY_TOO_LARGE' : 'REQUEST_REFUSED',
  };
}

/**
 * Reports whether a thrown value is the shared malformed-JSON rejection.
 *
 * @param error - The thrown value
 * @returns `true` when the body simply was not JSON
 */
function isMalformedBody(error: unknown): boolean {
  if (error instanceof MalformedRequestBodyError) {
    return true;
  }
  return typeof error === 'object' && error !== null &&
    (error as { name?: unknown }).name === 'MalformedRequestBodyError';
}
