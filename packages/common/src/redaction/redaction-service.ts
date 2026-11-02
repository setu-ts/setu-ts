/** The common synchronous redaction service implementation. */

import { createFieldMatcher } from './field-matcher.ts';
import type { RedactionPolicy } from './policy.ts';
import { eraseRedactor } from './redactors.ts';
import type { RedactionContext, Redactor } from './redactors.ts';

/** A synchronous service that redacts individual values and structured records. */
export interface IRedactionService {
  /** Redacts a value when its field path is classified. */
  redactValue(path: string, value: unknown): unknown;
  /**
   * Returns a redacted snapshot of a structured record: every plain object and
   * array it walks is read once and copied, so the result holds exactly the
   * values that were checked. The caller's record is never mutated.
   */
  redactRecord(record: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>>;
}

const MAX_REDACTION_DEPTH = 32;

const SCHEME_CHAR = /[a-z0-9+.-]/i;
const SCHEME_START = /[a-z]/i;
const WHITESPACE = /\s/;
const LINE_BREAK = /[\n\r\u2028\u2029]/;
const AUTHORITY_END = /[/?#]/;
const DIGIT = /[0-9]/;

/**
 * Masks a URL's userinfo in a string: `scheme://user:password@host` becomes
 * `scheme://***@host`. This is the default policy's one value-based rule — it
 * runs on every string value the redaction seam sees, and `describeError`
 * applies it to every message — so a malformed `REDIS_URL` (which often holds
 * a password) is not echoed into a log line or stderr.
 *
 * A URL is malformed precisely when its password carries a character it should
 * have encoded, so the rule leans toward hiding. It is a best-effort rule for
 * credentials pasted into text, not a URL parser; the common README lists the
 * shapes it masks and its known limits, and the test table holds each case:
 *
 * - The userinfo runs to the LAST `@` of the URL's word, so an unencoded `@`,
 *   `/`, `#`, `?` or `://` in the password is masked with it.
 * - A password holding whitespace is masked to the next `@` on the line when the
 *   text before the whitespace has a non-port `:`; a username holding
 *   whitespace when the next word is `name:password@host`; a password holding
 *   `@` then whitespace when the text after that `@` has no `.`, `:` or `/`.
 * - Untouched: a URL with no `@`, an email (no `://`), an `@` in a path or
 *   query with no `:` before it. Over-masked, on purpose: a path `@` after a
 *   port. Not masked: anything across a line break.
 *
 * Every string is inspected, whatever its length, in one linear pass from the
 * right: each position's next whitespace, next `@`, first `:` and so on are
 * known when its `://` is reached, and a scheme's walk back stops at the
 * previous non-scheme character.
 *
 * @param value - The string to inspect
 * @returns The string with any URL userinfo masked, or unchanged
 * @since 0.12.0
 */
export function maskUrlUserinfo(value: string): string {
  if (!value.includes('://')) return value;
  // Facts about the token (whitespace-free run) starting at the current index.
  let tokenEnd = value.length;
  let firstAt = -1;
  let lastAt = -1;
  let firstColon = -1;
  let colonPortLike = false;
  let firstAuthorityEnd = -1;
  let digitsToTokenEnd = true;
  // Rightmost `.`, `:` or `/` in the token: none after its last `@` means the
  // text after that `@` does not look like a host.
  let rightmostHostMark = -1;
  // The first `@` after the current token, on the same line.
  let nextAtAfterToken = -1;
  // The word right after the current token: its first `@`, and whether a `:`
  // comes before that `@` (a `user:password@` shape).
  let nextWordFirstAt = -1;
  let nextWordUserinfo = false;
  // Masked ranges [start, end), found right to left.
  const ranges: [number, number][] = [];
  for (let index = value.length - 1; index >= 0; index--) {
    const char = value[index]!;
    if (WHITESPACE.test(char)) {
      if (LINE_BREAK.test(char)) {
        nextAtAfterToken = nextWordFirstAt = -1;
        nextWordUserinfo = false;
      } else if (index + 1 < tokenEnd) {
        // Crossing from a non-empty word into whitespace: that word is now
        // "the next word" for the text to its left.
        if (firstAt !== -1) nextAtAfterToken = firstAt;
        nextWordFirstAt = firstAt;
        nextWordUserinfo = firstColon !== -1 && firstAt !== -1 && firstColon < firstAt;
      }
      tokenEnd = index;
      rightmostHostMark = -1;
      firstAt = lastAt = firstColon = firstAuthorityEnd = -1;
      colonPortLike = false;
      digitsToTokenEnd = true;
    } else {
      const digitsAfter = digitsToTokenEnd;
      digitsToTokenEnd = DIGIT.test(char) && digitsToTokenEnd;
      if (rightmostHostMark === -1 && (char === '.' || char === ':' || char === '/')) {
        rightmostHostMark = index;
      }
      if (char === '@') {
        firstAt = index;
        if (lastAt === -1) lastAt = index;
      } else if (char === ':' && !value.startsWith('//', index + 1)) {
        firstColon = index;
        colonPortLike = index + 1 < tokenEnd && digitsAfter;
      } else if (AUTHORITY_END.test(char)) {
        firstAuthorityEnd = index;
      }
    }
    if (index < 3 || !value.startsWith('://', index - 3)) continue;
    // `index` is the first character after a `://`; the facts describe it.
    const separator = index - 3;
    let schemeStart = separator;
    while (schemeStart > 0 && SCHEME_CHAR.test(value[schemeStart - 1]!)) schemeStart--;
    while (schemeStart < separator && !SCHEME_START.test(value[schemeStart]!)) schemeStart++;
    if (schemeStart === separator) continue;
    let end = -1;
    const colonBeforeLastAt = firstColon !== -1 && firstColon < lastAt;
    if (
      lastAt > index &&
      (firstAuthorityEnd === -1 || firstAt < firstAuthorityEnd || colonBeforeLastAt)
    ) {
      end = lastAt;
      // `redis://:p@SECRET wd@host`: a password holding `@` then whitespace.
      // The text after the token's last `@` has no `.`, `:` or `/`, so it may
      // be the rest of the password rather than a host; when the next word has
      // an `@`, the userinfo runs to it.
      if (colonBeforeLastAt && rightmostHostMark < lastAt && nextWordFirstAt !== -1) {
        end = nextWordFirstAt;
      }
    } else if (
      lastAt === -1 &&
      nextAtAfterToken !== -1 &&
      // `redis://:pw x@host`: a non-port `:` before the whitespace, or
      // `redis://us er:pw@host`: the next word is `name:password@host`.
      // A `:` straight after `://` has no host before it, so it is never a port.
      ((firstColon !== -1 &&
        (!colonPortLike || firstColon === index) &&
        (firstAuthorityEnd === -1 || firstColon < firstAuthorityEnd)) ||
        nextWordUserinfo)
    ) {
      end = nextAtAfterToken;
    }
    if (end !== -1) ranges.push([index, end]);
  }
  if (ranges.length === 0) return value;
  ranges.reverse();
  let out = '';
  let copied = 0;
  let current = ranges[0]!;
  for (let at = 1; at <= ranges.length; at++) {
    const next = ranges[at];
    if (next !== undefined && next[0] <= current[1]) {
      current = [current[0], Math.max(current[1], next[1])];
      continue;
    }
    out += value.slice(copied, current[0]) + '***';
    copied = current[1];
    if (next !== undefined) current = next;
  }
  return out + value.slice(copied);
}

/**
 * Compiles a policy into a synchronous redaction service.
 *
 * @param policy - Field classifications and redactor selection
 * @returns A compiled redaction service
 */
export function createRedactionService(
  policy: RedactionPolicy,
  options?: { readonly caseSensitive?: boolean },
): IRedactionService {
  const match = createFieldMatcher(policy.fields, options?.caseSensitive ?? false);
  const defaultRedactor = policy.defaultRedactor ?? eraseRedactor;
  const redactValue = (path: string, value: unknown): unknown => {
    const matched = match(path);
    if (matched === undefined) return typeof value === 'string' ? maskUrlUserinfo(value) : value;
    const classification = matched.classification;
    const context: RedactionContext = { path, classification };
    // Precedence: the field pattern's own redactor, then the redactor keyed by
    // its classification, then the policy default, then erase.
    // `matched.redactor` is read as an OWN property: a plain read would reach
    // a polluted `Object.prototype.redactor` and emit every matched value raw.
    const fieldRedactor = Object.hasOwn(matched, 'redactor') ? matched.redactor : undefined;
    const redactor: Redactor =
      fieldRedactor ??
      (policy.redactors !== undefined && Object.hasOwn(policy.redactors, classification)
        ? policy.redactors[classification]!
        : defaultRedactor);
    return redactor(value, context);
  };
  return {
    redactValue,
    redactRecord(record: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
      // The record itself is walked like any nested object: one traversability
      // check, so a non-object from a JavaScript caller is returned unchanged.
      return descend(record, '', 0, redactValue, {
        active: undefined,
        traversable: undefined,
      }) as Readonly<Record<string, unknown>>;
    },
  };
}

/**
 * The copies under construction on the current traversal path, keyed by the
 * caller's object, so a cycle resolves to its copy. Created when the walk
 * first enters a traversable child: a flat record (every request-log entry)
 * never needs one.
 */
interface Traversal {
  active: Map<object, unknown[] | Record<string, unknown>> | undefined;
  /**
   * Each object's FIRST traversability answer for this redaction, created
   * with `active`. A Proxy reached twice — a sibling alias or a cycle — could
   * answer "plain" once and "not plain" the next time, and the second
   * reference was returned unredacted (PR #518 review). A flat record is never
   * re-entered, so it needs no cache.
   */
  traversable: Map<object, boolean> | undefined;
}

/**
 * Copies and walks an object the path did not redact — the record itself, or
 * a child whose own path matched no pattern. Its traversability is
 * checked HERE and nowhere else: a Proxy can answer two prototype reads
 * differently, and a caller-side check that said "plain" followed by this one
 * saying "not plain" returned the original object — its nested secrets
 * unredacted (PR #518 review).
 */
function descend(
  direct: object,
  path: string,
  depth: number,
  redactValue: (path: string, value: unknown) => unknown,
  traversal: Traversal,
): unknown {
  let traversable = traversal.traversable?.get(direct);
  if (traversable === undefined) {
    traversable = isTraversable(direct);
    traversal.traversable?.set(direct, traversable);
  }
  if (!traversable) return direct;
  if (depth >= MAX_REDACTION_DEPTH) {
    return eraseRedactor(direct, { path, classification: '' });
  }
  const activeCopy = traversal.active?.get(direct);
  if (activeCopy !== undefined) return activeCopy;

  // One read per property: the copy and the redaction decisions both come from
  // this snapshot. Reading twice let a getter hand the copy a secret-bearing
  // object and the traversal a clean one, so the secret was never redacted.
  const entries: [PropertyKey, unknown][] = Array.isArray(direct)
    ? [...direct.entries()]
    : Object.entries(direct);
  const copy = Array.isArray(direct)
    ? entries.map(([, child]) => child)
    : // Traversable and not an array: a plain object, by the answer cached above.
      snapshotCopy(direct as Record<string, unknown>, entries);
  let entered = false;
  try {
    for (const [key, child] of entries) {
      const childPath = path === '' ? String(key) : `${path}.${String(key)}`;
      // The child's own path decides first, once. A match or a primitive is
      // final; any other object is handed to `descend`, which alone decides
      // whether it can be walked.
      let decided = redactValue(childPath, child);
      // The default URL-userinfo mask runs on every string value, classified or
      // not: a URL that carries credentials is a secret wherever it appears.
      if (typeof decided === 'string') decided = maskUrlUserinfo(decided);
      let redacted: unknown;
      if (decided !== child || typeof child !== 'object' || child === null) {
        redacted = decided;
      } else {
        if (!entered) {
          (traversal.active ??= new Map()).set(direct, copy);
          (traversal.traversable ??= new Map()).set(direct, true);
          entered = true;
        }
        redacted = descend(child, childPath, depth + 1, redactValue, traversal);
      }
      if (redacted !== child) {
        if (Array.isArray(copy)) {
          copy[Number(key)] = redacted;
        } else {
          copy[String(key)] = redacted;
        }
      }
    }
  } finally {
    if (entered) traversal.active!.delete(direct);
  }
  // Always the snapshot, never the caller's object, even when nothing changed:
  // returning `direct` let the serializer read a getter again after redaction
  // and write a value redaction never checked (pino's redactor copies too).
  return copy;
}

/**
 * Rebuilds `{ ...value }` from already-read string entries, adding the
 * enumerable symbol-keyed values a spread would also copy (read once each,
 * never traversed). Every key becomes an own data property, as
 * `Object.fromEntries` would make it, so no setter runs with an unredacted
 * value: a key the empty copy already INHERITS — `__proto__`, or a setter
 * placed on a polluted `Object.prototype` — is defined, any other is assigned
 * (PR #518 review; assignment is cheaper than `fromEntries` on Node).
 */
function snapshotCopy(
  value: Record<string, unknown>,
  entries: readonly [PropertyKey, unknown][],
): Record<string, unknown> {
  const copy: Record<PropertyKey, unknown> = {};
  for (const [key, child] of entries) {
    setOwn(copy, key, child);
  }
  for (const symbol of Object.getOwnPropertySymbols(value)) {
    if (Object.prototype.propertyIsEnumerable.call(value, symbol)) {
      setOwn(copy, symbol, Reflect.get(value, symbol));
    }
  }
  return copy;
}

/**
 * Makes `key` an own data property of `target` without running an inherited
 * setter. `in` reads no property, so the check itself runs no accessor.
 */
function setOwn(target: Record<PropertyKey, unknown>, key: PropertyKey, child: unknown): void {
  if (key in target) {
    Object.defineProperty(target, key, {
      value: child,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  } else {
    target[key] = child;
  }
}

/** Limits structural traversal to arrays and dictionary-like objects. */
function isTraversable(value: unknown): value is Record<string, unknown> | unknown[] {
  if (typeof value !== 'object' || value === null) return false;
  if (Array.isArray(value)) return true;
  // One prototype read: a Proxy may answer each read differently.
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
