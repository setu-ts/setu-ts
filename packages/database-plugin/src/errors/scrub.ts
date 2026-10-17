/** Removes Drizzle bound values before driver errors reach an egress sink. */
import { causeChain } from './classify.ts';

/**
 * Scrubs query wrappers over the classifier's bounded, cycle-safe cause walk.
 * Other nodes retain their identity and driver classifier fields.
 * @param error - The original rejection
 * @returns The diagnostic without Drizzle parameter values
 * @internal
 */
export function scrubDriverError(error: unknown): unknown {
  const chain = causeChain(error);
  const replacements = new Map<object, object>();
  for (const node of chain) {
    const candidate = node as { query?: unknown; params?: unknown };
    if (
      node instanceof Error &&
      Object.hasOwn(node, 'query') &&
      typeof candidate.query === 'string' &&
      Object.hasOwn(node, 'params') &&
      Array.isArray(candidate.params) &&
      node.message.startsWith('Failed query: ')
    ) {
      const clean = new Error(`Failed query: ${candidate.query}`);
      clean.name = node.name;
      const lines = node.stack?.split('\n') ?? [];
      const firstFrame = lines.findIndex((line) => /^\s*at\s/.test(line));
      clean.stack =
        clean.message + (firstFrame < 0 ? '' : `\n${lines.slice(firstFrame).join('\n')}`);
      Object.defineProperty(clean, 'query', { value: candidate.query, enumerable: true });
      replacements.set(node, clean);
    }
  }
  // Allocate every query replacement before linking, then link tail first: a
  // wrapper whose `cause` cannot be redefined (a frozen error) is itself
  // replaced by a copy, and the nodes above it link to that copy. The error
  // path must never become the fault, so no relink is allowed to throw.
  for (const node of [...chain].reverse()) {
    const cause = (node as { cause?: unknown }).cause;
    const next =
      typeof cause === 'object' && cause !== null ? (replacements.get(cause) ?? cause) : cause;
    const target = replacements.get(node) ?? node;
    if (next === undefined || (target === node && next === cause)) continue;
    try {
      Object.defineProperty(target, 'cause', { value: next, writable: true, configurable: true });
    } catch {
      replacements.set(node, copyWithCause(node as Error, next));
    }
  }
  return typeof error === 'object' && error !== null ? (replacements.get(error) ?? error) : error;
}

/**
 * Copies a wrapper whose `cause` cannot be redefined, keeping its name,
 * message, stack and own enumerable fields (a driver `code`, for example).
 */
function copyWithCause(node: Error, cause: unknown): Error {
  const copy = new Error(node.message, { cause });
  for (const [key, value] of Object.entries(node)) {
    if (key !== 'cause') Object.defineProperty(copy, key, { value, enumerable: true });
  }
  copy.name = node.name;
  if (node.stack !== undefined) copy.stack = node.stack;
  return copy;
}
