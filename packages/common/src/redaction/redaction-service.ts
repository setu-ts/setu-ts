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
    if (matched === undefined) return value;
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
      return descend(record, '', 0, redactValue, { active: undefined }) as Readonly<
        Record<string, unknown>
      >;
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
  if (!isTraversable(direct)) return direct;
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
    : snapshotCopy(direct, entries);
  let entered = false;
  try {
    for (const [key, child] of entries) {
      const childPath = path === '' ? String(key) : `${path}.${String(key)}`;
      // The child's own path decides first, once. A match or a primitive is
      // final; any other object is handed to `descend`, which alone decides
      // whether it can be walked.
      const decided = redactValue(childPath, child);
      let redacted: unknown;
      if (decided !== child || typeof child !== 'object' || child === null) {
        redacted = decided;
      } else {
        if (!entered) {
          (traversal.active ??= new Map()).set(direct, copy);
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
 * never traversed). Filled in one loop rather than `Object.fromEntries`; an
 * own `__proto__` key is defined, as `fromEntries` defines it, never assigned
 * (an assignment would replace the copy's prototype).
 */
function snapshotCopy(
  value: Record<string, unknown>,
  entries: readonly [PropertyKey, unknown][],
): Record<string, unknown> {
  const copy: Record<PropertyKey, unknown> = {};
  for (const [key, child] of entries) {
    if (key === '__proto__') {
      Object.defineProperty(copy, key, {
        value: child,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    } else {
      copy[key] = child;
    }
  }
  for (const symbol of Object.getOwnPropertySymbols(value)) {
    if (Object.prototype.propertyIsEnumerable.call(value, symbol)) {
      copy[symbol] = Reflect.get(value, symbol);
    }
  }
  return copy;
}

/** Limits structural traversal to arrays and dictionary-like objects. */
function isTraversable(value: unknown): value is Record<string, unknown> | unknown[] {
  if (typeof value !== 'object' || value === null) return false;
  if (Array.isArray(value)) return true;
  // One prototype read: a Proxy may answer each read differently.
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
