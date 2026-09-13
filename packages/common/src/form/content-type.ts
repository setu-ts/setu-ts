/**
 * Media-type parsing for the form classifier and the multipart parser.
 *
 * These two MUST agree: `formEncodingOf` promises a parse and `parseMultipart`
 * performs it, so a header one accepts and the other refuses surfaces as the
 * parser's own unbranded `Error` where the accessor documented a `415` — i.e. a
 * masked `500`. They agreed by coincidence while both searched the raw header
 * with `includes()` and a loose `boundary=` regex; sharing ONE parse is what
 * makes the agreement structural instead of coincidental.
 *
 * The loose search also mis-classified real headers. Measured before this
 * module existed: `application/x-www-form-urlencoded-v2` classified as
 * urlencoded (a suffixed media type), `text/plain; note="application/x-www-
 * form-urlencoded"` classified as urlencoded (supported-type text inside an
 * unrelated QUOTED parameter), and `multipart/form-data; xboundary=q`
 * classified as multipart (`boundary=` matched inside a different parameter
 * name). Each sent a non-form body into form parsing.
 *
 * @module
 */

/** A `content-type` header split into its media type and parameters. */
export interface ParsedContentType {
  /** The media type, lower-cased and trimmed (`'multipart/form-data'`). */
  readonly mediaType: string;
  /** Parameters keyed by lower-cased name, values unquoted. */
  readonly parameters: ReadonlyMap<string, string>;
}

/**
 * Splits a `content-type` header into its media type and parameters.
 *
 * Quoted parameter values are honoured, so a `;` inside quotes does not end the
 * value and a quoted value is never mistaken for a media type. Parameter names
 * are lower-cased because RFC 9110 §5.6.6 defines them case-insensitively; a
 * value is returned verbatim, since a multipart `boundary` is case-SENSITIVE
 * and must match the delimiter in the body byte for byte.
 *
 * @param contentType - The raw header value
 * @returns The parsed media type and parameters
 * @since 0.6.0
 */
export function parseContentType(contentType: string): ParsedContentType {
  const segments = splitSegments(contentType);
  const mediaType = (segments[0] ?? '').trim().toLowerCase();
  const parameters = new Map<string, string>();

  for (let i = 1; i < segments.length; i++) {
    const segment = segments[i] as string;
    const equals = segment.indexOf('=');
    if (equals === -1) continue;
    const name = segment.slice(0, equals).trim().toLowerCase();
    if (name === '') continue;
    // First occurrence wins, matching how `Headers` and the cookie codec in
    // this package resolve a repeated name.
    if (!parameters.has(name)) parameters.set(name, unquote(segment.slice(equals + 1).trim()));
  }

  return { mediaType, parameters };
}

/**
 * Splits on `;` while treating a quoted run as opaque.
 *
 * A parameter value may legally contain `;` inside quotes
 * (`boundary="a;b"`), so a bare `split(';')` would cut it in half and leave the
 * tail looking like another parameter.
 */
function splitSegments(value: string): string[] {
  const segments: string[] = [];
  let start = 0;
  let quote: string | null = null;

  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (quote !== null) {
      // A backslash escapes the next character inside a quoted string
      // (RFC 9110 quoted-pair), so `"a\"b"` is one value, not two.
      if (char === '\\') i++;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === ';') {
      segments.push(value.slice(start, i));
      start = i + 1;
    }
  }
  segments.push(value.slice(start));
  return segments;
}

/** Strips surrounding quotes and resolves quoted-pair escapes. */
function unquote(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  if ((first !== '"' && first !== "'") || value[value.length - 1] !== first) return value;
  return value.slice(1, -1).replace(/\\(.)/g, '$1');
}
