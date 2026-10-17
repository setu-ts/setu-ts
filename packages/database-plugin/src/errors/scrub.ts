/**
 * Removes bound values before driver errors reach an egress sink: Drizzle's
 * `Failed query:` wrapper, and SQLSTATE class 22 messages that quote the input.
 */
import { causeChain } from './classify.ts';

/**
 * Scrubs query wrappers and data exceptions over the classifier's bounded,
 * cycle-safe cause walk. Other nodes retain their identity and driver fields.
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
      clean.stack = withFramesOf(clean.message, node.stack);
      Object.defineProperty(clean, 'query', { value: candidate.query, enumerable: true });
      replacements.set(node, clean);
    } else if (isDataException(node)) {
      replacements.set(node, scrubbedDataException(node));
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

/**
 * Replaces the stack's header, which repeats the original message, with
 * `message`, keeping only the frame lines.
 */
function withFramesOf(message: string, stack: string | undefined): string {
  const lines = stack?.split('\n') ?? [];
  const firstFrame = lines.findIndex((line) => /^\s*at\s/.test(line));
  return message + (firstFrame < 0 ? '' : `\n${lines.slice(firstFrame).join('\n')}`);
}

/**
 * SQLSTATE class 22 (data exception): PostgreSQL's message quotes the
 * rejected input (`invalid input syntax for type uuid: "<value>"`), so
 * it carries a bound value whatever the statement was.
 */
function isDataException(node: unknown): node is Error & { code: string } {
  if (!(node instanceof Error)) return false;
  const code: unknown = (node as { code?: unknown }).code;
  return typeof code === 'string' && /^22[0-9A-Z]{3}$/.test(code);
}

/**
 * Rebuilds a data exception from its code alone, so classification still
 * reads the SQLSTATE while the message, stack header and driver fields
 * (`where`, `detail`) that quote the input are gone.
 */
function scrubbedDataException(node: Error & { code: string }): Error {
  const clean = new Error(`Data exception (SQLSTATE ${node.code})`);
  clean.name = node.name;
  clean.stack = withFramesOf(clean.message, node.stack);
  Object.defineProperty(clean, 'code', { value: node.code, enumerable: true });
  const severity = (node as { severity?: unknown }).severity;
  if (typeof severity === 'string') {
    Object.defineProperty(clean, 'severity', { value: severity, enumerable: true });
  }
  return clean;
}
