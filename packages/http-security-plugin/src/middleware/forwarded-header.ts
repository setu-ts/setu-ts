/** Bounded RFC 7239 parsing. Internal to HTTP security. @module */
import { parseIpLiteral } from './normalize-ip.ts';

/** One proxy-written element; an absent IP is an unresolvable hop. */
export interface IForwardedElement {
  readonly ip?: string;
  readonly proto?: string;
  readonly host?: string;
}

/**
 * Marker for a field region the parser could not read: an element this parser
 * refused, or everything left of the trailing window it recovers from.
 *
 * A `MALFORMED` entry is a boundary in the forwarded chain, not a void. Entries
 * to its RIGHT were written by later hops and are still read; the trust walk
 * stops at the boundary and never continues past it (M119d §3.1). Exported for
 * the chain builder only — never from `src/index.ts`.
 */
export const MALFORMED: unique symbol = Symbol.for('setu.http-security.forwarded-malformed');

/** Longest field (and recovery window) accepted: 8192 UTF-8 bytes. */
const MAX_BYTES = 8192;

/** Most elements a strict parse may return and a recovery pass may keep. */
const MAX_ELEMENTS = 64;

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const encoder = new TextEncoder();

/**
 * Parses a complete Forwarded field.
 *
 * The strict pass is left-to-right RFC 7239 over the whole field and is
 * unchanged for every well-formed field within the bounds (64 elements,
 * 8192 UTF-16 units and 8192 UTF-8 bytes). A field it refuses is re-read by the
 * recovery pass from the RIGHT: the trailing window of at most 8192 UTF-8 bytes
 * is split on `,` and each segment is parsed with the same element grammar.
 * Well-formed segments are kept in wire order up to 64; the first segment that
 * does not parse, and everything left of it, collapses into ONE leading
 * {@linkcode MALFORMED} entry. A window cut at a code-point boundary starts with
 * a partial segment, which is itself the boundary.
 *
 * @param value - The raw field value
 * @returns Wire-order elements and boundaries; never `undefined`
 * @internal
 */
export function parseForwarded(value: string): readonly (IForwardedElement | typeof MALFORMED)[] {
  const strict = parseStrict(value);
  return strict ?? recover(value);
}

/**
 * The strict left-to-right pass. `undefined` means the field is malformed or
 * exceeds a bound, which sends it to {@linkcode recover}.
 */
function parseStrict(value: string): readonly IForwardedElement[] | undefined {
  if (value.length > MAX_BYTES || encoder.encode(value).length > MAX_BYTES) return undefined;
  const elements: IForwardedElement[] = [];
  let offset = 0;
  while (offset < value.length) {
    if (elements.length === MAX_ELEMENTS) return undefined;
    const parsed = parseElementAt(value, offset);
    if (parsed === undefined) return undefined;
    elements.push(parsed.element);
    offset = parsed.end;
    if (offset === value.length) return elements;
    if (value[offset++] !== ',' || offset === value.length) return undefined;
  }
  return undefined;
}

/** One element and the offset just past it. */
interface IParsedElement {
  readonly element: IForwardedElement;
  readonly end: number;
}

/**
 * The single-element grammar shared by both passes: `name=value` pairs
 * separated by `;`, stopping at `,` or the end of the string.
 *
 * @returns The element and the offset after it, or `undefined` when malformed
 */
function parseElementAt(value: string, from: number): IParsedElement | undefined {
  let offset = from;
  const pairs = new Map<string, string>();
  while (true) {
    while (value[offset] === ' ' || value[offset] === '\t') offset++;
    const start = offset;
    while (offset < value.length && TOKEN.test(value[offset]!)) offset++;
    if (offset === start || value[offset++] !== '=') return undefined;
    const name = value.slice(start, offset - 1).toLowerCase();
    if (pairs.has(name)) return undefined;
    let parsed = '';
    if (value[offset] === '"') {
      offset++;
      let closed = false;
      while (offset < value.length) {
        let char = value[offset++]!;
        if (char === '"') {
          closed = true;
          break;
        }
        if (char === '\\') {
          if (offset === value.length) return undefined;
          char = value[offset++]!;
        }
        const code = char.charCodeAt(0);
        if ((code < 32 && code !== 9) || code === 127) return undefined;
        parsed += char;
      }
      if (!closed) return undefined;
    } else {
      const startValue = offset;
      while (offset < value.length && TOKEN.test(value[offset]!)) offset++;
      if (offset === startValue) return undefined;
      parsed = value.slice(startValue, offset);
    }
    pairs.set(name, parsed);
    while (value[offset] === ' ' || value[offset] === '\t') offset++;
    if (value[offset] !== ';') break;
    offset++;
  }
  const node = pairs.get('for');
  const ip = node === undefined ? undefined : parseNode(node);
  if (ip === null) return undefined;
  const proto = pairs.get('proto');
  const host = pairs.get('host');
  return {
    element: {
      ...(ip === undefined ? {} : { ip }),
      ...(proto === undefined ? {} : { proto }),
      ...(host === undefined ? {} : { host }),
    },
    end: offset,
  };
}

/**
 * Re-reads a refused field from the right, within the trailing window.
 *
 * Linear in the window: the window is cut once at a code-point boundary, split
 * once, and each segment is parsed once until one fails or 64 are kept. A
 * boundary is recorded only when one was actually hit; a window that fits
 * whole with every segment well formed has no `MALFORMED` entry.
 */
function recover(value: string): readonly (IForwardedElement | typeof MALFORMED)[] {
  const window = trailingWindow(value);
  const segments = window.text.split(',');
  const kept: (IForwardedElement | typeof MALFORMED)[] = [];
  for (let index = segments.length - 1; index >= 0; index--) {
    // A cut window starts with a partial segment; that segment is the boundary
    // and is never parsed.
    if (index === 0 && window.cut) {
      kept.push(MALFORMED);
      break;
    }
    if (kept.length === MAX_ELEMENTS) {
      kept.push(MALFORMED);
      break;
    }
    const segment = trimSegment(segments[index]!);
    if (segment === '') {
      kept.push(MALFORMED);
      break;
    }
    const parsed = parseElementAt(segment, 0);
    if (parsed === undefined || parsed.end !== segment.length) {
      kept.push(MALFORMED);
      break;
    }
    kept.push(parsed.element);
  }
  kept.reverse();
  return kept;
}

/** A trailing window of the field and whether anything was cut from its front. */
interface ITrailingWindow {
  readonly text: string;
  readonly cut: boolean;
}

/**
 * The last at most 8192 UTF-8 bytes of a field, cut on a code-point boundary so
 * a surrogate pair or a multi-byte character is never split.
 */
function trailingWindow(value: string): ITrailingWindow {
  let bytes = 0;
  let index = value.length;
  while (index > 0) {
    let start = index - 1;
    const low = value.charCodeAt(start);
    if (low >= 0xdc00 && low <= 0xdfff && start > 0) {
      const high = value.charCodeAt(start - 1);
      if (high >= 0xd800 && high <= 0xdbff) start -= 1;
    }
    const size = utf8Length(value, start);
    if (bytes + size > MAX_BYTES) return { text: value.slice(index), cut: true };
    bytes += size;
    index = start;
  }
  return { text: value, cut: false };
}

/** UTF-8 byte width of the code point that starts at `start`. */
function utf8Length(value: string, start: number): number {
  const code = value.codePointAt(start)!;
  if (code < 0x80) return 1;
  if (code < 0x800) return 2;
  if (code < 0x10000) return 3;
  return 4;
}

/**
 * Trims spaces and tabs only — the delimiters the element grammar skips.
 * Index-based rather than a regular expression: an alternation anchored at the
 * end backtracks quadratically on a long inner run of whitespace, which any
 * client can send (M119d audit M1).
 */
function trimSegment(segment: string): string {
  let start = 0;
  let end = segment.length;
  while (start < end && (segment[start] === ' ' || segment[start] === '\t')) start++;
  while (end > start && (segment[end - 1] === ' ' || segment[end - 1] === '\t')) end--;
  return segment.slice(start, end);
}

/** A null node is malformed; undefined is a valid unknown/obfuscated hop. */
function parseNode(node: string): string | null | undefined {
  const match = /^(\[[^\]]+\]|[^:]+)(?::([0-9]+|_[A-Za-z0-9._-]+))?$/.exec(node);
  if (match === null) return null;
  const address = match[1]!;
  if (/^(unknown|_[A-Za-z0-9._-]+)$/i.test(address)) return undefined;
  if (address.startsWith('[')) {
    const literal = address.slice(1, -1);
    return literal.includes(':') ? parseIpLiteral(literal) : null;
  }
  return parseIpLiteral(address);
}
