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
    if (!(node instanceof Error)) continue;
    // Every read goes through `safeRead`: a driver error is foreign input, and
    // an accessor that throws must not turn the error path into the fault.
    const query = Object.hasOwn(node, 'query') ? safeRead(node, 'query') : undefined;
    const params = Object.hasOwn(node, 'params') ? safeRead(node, 'params') : undefined;
    const message = safeRead(node, 'message');
    if (
      typeof query === 'string' &&
      Array.isArray(params) &&
      typeof message === 'string' &&
      message.startsWith('Failed query: ')
    ) {
      const clean = new Error(`Failed query: ${query}`);
      clean.name = nameOf(node);
      clean.stack = withFramesOf(clean.message, safeRead(node, 'stack'), safeRead(node, 'message'));
      Object.defineProperty(clean, 'query', { value: query, enumerable: true });
      replacements.set(node, clean);
      continue;
    }
    const code = safeRead(node, 'code');
    if (typeof code === 'string' && /^22[0-9A-Z]{3}$/.test(code)) {
      replacements.set(node, scrubbedDataException(node, code));
    }
  }
  // Allocate every query replacement before linking, then link tail first: a
  // wrapper whose `cause` cannot be redefined (a frozen error) is itself
  // replaced by a copy, and the nodes above it link to that copy. The error
  // path must never become the fault, so no relink is allowed to throw.
  for (const node of [...chain].reverse()) {
    const cause = safeRead(node as object, 'cause');
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
  const message = safeRead(node, 'message');
  const copy = new Error(typeof message === 'string' ? message : '', { cause });
  for (const key of Object.keys(node)) {
    if (key !== 'cause') {
      Object.defineProperty(copy, key, { value: safeRead(node, key), enumerable: true });
    }
  }
  copy.name = nameOf(node);
  const stack = safeRead(node, 'stack');
  if (typeof stack === 'string') copy.stack = stack;
  return copy;
}

/**
 * Replaces the stack's header, which repeats the original message, with
 * `message`, keeping only what follows the header.
 *
 * The header is `<name>: <original message>`, and the original message may
 * span lines and quote bound values — so the header is located by finding the
 * original message itself, never by searching for the first frame-shaped
 * line, which a value such as `x\n    at forged (evil.js:1:1)` would fake
 * (M113g audit round 3, L6). When the original message is not found on the
 * stack's first line, no frames are kept: losing frames is safe, keeping a
 * header that may carry a value is not.
 */
function withFramesOf(message: string, stack: unknown, original: unknown): string {
  if (typeof stack !== 'string') return message;
  let rest: string | undefined;
  if (typeof original === 'string' && original !== '') {
    const at = stack.indexOf(original);
    if (at >= 0 && !stack.slice(0, at).includes('\n')) rest = stack.slice(at + original.length);
  } else {
    const newline = stack.indexOf('\n');
    rest = newline < 0 ? '' : stack.slice(newline);
  }
  return rest !== undefined && rest.startsWith('\n') ? message + rest : message;
}

/**
 * Reads one property of a foreign error, answering `undefined` when its
 * accessor throws.
 */
function safeRead(node: object, key: string): unknown {
  try {
    return (node as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/** The node's name when it is a string, otherwise `'Error'`. */
function nameOf(node: object): string {
  const name = safeRead(node, 'name');
  return typeof name === 'string' ? name : 'Error';
}

/**
 * Rebuilds a SQLSTATE class 22 (data exception) cause from its code alone:
 * PostgreSQL's message quotes the rejected input
 * (`invalid input syntax for type uuid: "<value>"`), so the message, stack
 * header and driver fields (`where`, `detail`) all go, while classification
 * still reads the code.
 */
function scrubbedDataException(node: Error, code: string): Error {
  const clean = new Error(`Data exception (SQLSTATE ${code})`);
  clean.name = nameOf(node);
  clean.stack = withFramesOf(clean.message, safeRead(node, 'stack'), safeRead(node, 'message'));
  Object.defineProperty(clean, 'code', { value: code, enumerable: true });
  const severity = safeRead(node, 'severity');
  if (typeof severity === 'string') {
    Object.defineProperty(clean, 'severity', { value: severity, enumerable: true });
  }
  return clean;
}
