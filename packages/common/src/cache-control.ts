/**
 * Directive names of a `Cache-Control` header value, for the components that decide what a cache
 * may store (`cache-plugin`, `session-plugin`), so they read one header the same way.
 *
 * @module
 */

/**
 * The directive names of a `Cache-Control` value, lowercased (RFC 9111 §5.2). Directives split at
 * commas outside quoted-string arguments, honouring backslash escapes inside them, so a comma or a
 * directive name inside an argument (`x="a,public"`) is not read as a directive.
 *
 * @param cacheControl - The header value
 * @returns The directive names in order, or `undefined` when a quoted-string is never closed: the
 *   value is malformed, and each caller decides which way that fails safe
 * @example
 * ```typescript
 * cacheControlDirectives('public, max-age=60, x="a,private"'); // ['public', 'max-age', 'x']
 * ```
 * @since 0.14.0
 */
export function cacheControlDirectives(cacheControl: string): readonly string[] | undefined {
  const names: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < cacheControl.length; i++) {
    const char = cacheControl[i]!;
    if (quoted) {
      if (char === '\\') {
        i++;
      } else if (char === '"') {
        quoted = false;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      names.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  if (quoted) {
    return undefined;
  }
  names.push(current);
  return names.map((part) => part.split('=')[0]!.trim().toLowerCase());
}
