/**
 * The one request-body media-type rule for the GraphQL POST routes.
 *
 * Both `POST <path>` and the SSE `POST <path>/stream` call this before reading
 * the body, so the two routes cannot disagree about what runs.
 *
 * @module
 */

/**
 * Reports whether a `content-type` header names `application/json`.
 *
 * The media type — the text before the first `;`, trimmed and lower-cased —
 * must EQUAL `application/json`; parameters (`charset` included) are ignored.
 * A substring test is not enough: the Fetch spec decides whether a request is
 * CORS-safelisted (sent cross-site with no preflight) from the same parsed
 * media type and allows parameters, so `text/plain; x=application/json` is a
 * simple request that a substring test reads as JSON. A missing header, an
 * empty one, and a comma list are refused; a quote can only appear after the
 * first `;`, so splitting there is exact for the media type.
 *
 * @param header - The raw `content-type` header, or `null` when absent
 * @returns `true` only for `application/json`
 */
export function isJsonContentType(header: string | null): boolean {
  if (header === null) return false;
  const end = header.indexOf(';');
  const mediaType = end === -1 ? header : header.slice(0, end);
  return mediaType.trim().toLowerCase() === 'application/json';
}
