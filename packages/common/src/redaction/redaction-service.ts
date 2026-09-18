/** The common synchronous redaction service implementation. */

import { createFieldMatcher } from './field-matcher.ts';
import type { RedactionPolicy } from './policy.ts';
import { eraseRedactor } from './redactors.ts';
import type { RedactionContext, Redactor } from './redactors.ts';

/** A synchronous service that redacts individual values and structured records. */
export interface IRedactionService {
  /** Redacts a value when its field path is classified. */
  redactValue(path: string, value: unknown): unknown;
  /** Returns a clone-on-write redacted view of a structured record. */
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
    const classification = match(path);
    if (classification === undefined) return value;
    const context: RedactionContext = { path, classification };
    const redactor: Redactor = policy.redactors !== undefined &&
        Object.hasOwn(policy.redactors, classification)
      ? policy.redactors[classification]!
      : defaultRedactor;
    return redactor(value, context);
  };
  return {
    redactValue,
    redactRecord(record: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
      return redactNode(record, '', 0, redactValue, new Map()) as Readonly<Record<string, unknown>>;
    },
  };
}

/** Redacts a traversable node without mutating its caller-owned graph. */
function redactNode(
  value: unknown,
  path: string,
  depth: number,
  redactValue: (path: string, value: unknown) => unknown,
  active: Map<object, unknown[] | Record<string, unknown>>,
): unknown {
  const direct = path === '' ? value : redactValue(path, value);
  if (direct !== value || !isTraversable(direct)) return direct;
  if (depth >= MAX_REDACTION_DEPTH) {
    return eraseRedactor(direct, { path, classification: '' });
  }
  const activeCopy = active.get(direct);
  if (activeCopy !== undefined) return activeCopy;

  const copy: unknown[] | Record<string, unknown> = Array.isArray(direct)
    ? [...direct]
    : { ...direct };
  active.set(direct, copy);
  const entries = Array.isArray(direct) ? direct.entries() : Object.entries(direct);
  let changed = false;
  try {
    for (const [key, child] of entries) {
      const childPath = path === '' ? String(key) : `${path}.${String(key)}`;
      const redacted = redactNode(child, childPath, depth + 1, redactValue, active);
      if (redacted !== child) {
        if (Array.isArray(copy)) {
          copy[Number(key)] = redacted;
        } else {
          copy[String(key)] = redacted;
        }
        changed = true;
      }
    }
  } finally {
    active.delete(direct);
  }
  return changed ? copy : direct;
}

/** Limits structural traversal to arrays and dictionary-like objects. */
function isTraversable(value: unknown): value is Record<string, unknown> | unknown[] {
  if (typeof value !== 'object' || value === null) return false;
  if (Array.isArray(value)) return true;
  return Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null;
}
