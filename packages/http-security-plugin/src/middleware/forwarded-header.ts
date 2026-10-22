/** Bounded RFC 7239 parsing. Internal to HTTP security. @module */

/** One proxy-written element; an absent IP is an unresolvable hop. */
export interface IForwardedElement {
  readonly ip?: string;
  readonly proto?: string;
  readonly host?: string;
}

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const encoder = new TextEncoder();

/**
 * Parses a complete Forwarded field, refusing malformed or excessive input.
 * @param value - The raw field value
 * @returns Wire-order elements, or undefined for malformed input
 * @internal
 */
export function parseForwarded(value: string): readonly IForwardedElement[] | undefined {
  if (value.length > 8192 || encoder.encode(value).length > 8192) return undefined;
  const elements: IForwardedElement[] = [];
  let offset = 0;
  while (offset < value.length) {
    if (elements.length === 64) return undefined;
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
    elements.push({
      ...(ip === undefined ? {} : { ip }),
      ...(proto === undefined ? {} : { proto }),
      ...(host === undefined ? {} : { host }),
    });
    if (offset === value.length) return elements;
    if (value[offset++] !== ',' || offset === value.length) return undefined;
  }
  return undefined;
}

/** A null node is malformed; undefined is a valid unknown/obfuscated hop. */
function parseNode(node: string): string | null | undefined {
  const match = /^(\[[^\]]+\]|[^:]+)(?::([0-9]+|_[A-Za-z0-9._-]+))?$/.exec(node);
  if (match === null) return null;
  const address = match[1]!;
  if (/^(unknown|_[A-Za-z0-9._-]+)$/i.test(address)) return undefined;
  if (address.startsWith('[')) {
    try {
      const url = new URL(`http://${address}`);
      return url.hostname.startsWith('[') ? address.slice(1, -1) : null;
    } catch {
      return null;
    }
  }
  const parts = address.split('.');
  return parts.length === 4 &&
    parts.every((part) => /^(0|[1-9][0-9]{0,2})$/.test(part) && Number(part) <= 255)
    ? address
    : null;
}
