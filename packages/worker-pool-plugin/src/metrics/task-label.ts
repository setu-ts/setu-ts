/**
 * Task labels — the operator-facing name of a task-module pool.
 *
 * A task module is addressed by specifier, normally
 * `new URL('./tasks/x.ts', import.meta.url).href`: a `file:` URL that carries
 * the machine's directory layout and the user's name. That specifier stays the
 * in-process key (`run()`, `stats()`, error messages and logs); the label is
 * what leaves the process, on `/metrics` and in the `/health` payload.
 *
 * Internal to the plugin (not exported from the barrel).
 *
 * @module
 */

/** Longest label, explicit or derived. */
const MAX_LABEL_LENGTH = 64;

/** The shape an explicit `pools[specifier].label` must take. */
const LABEL_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

/** Label for a module that has no path: a `data:` or `blob:` URL. */
const INLINE_LABEL = 'inline';

/** Label when nothing usable remains of the specifier. */
const FALLBACK_LABEL = 'task';

/**
 * Derives a label from a specifier: the last path segment, percent-decoded,
 * without its final extension, with every character outside `[A-Za-z0-9_.-]`
 * replaced by `_`, at most 64 characters. Never a path, never a scheme.
 *
 * @param specifier - The task-module specifier passed to `run()`
 * @returns The derived label
 */
export function deriveTaskLabel(specifier: string): string {
  let path = specifier;
  try {
    const url = new URL(specifier);
    if (url.protocol === 'data:' || url.protocol === 'blob:') return INLINE_LABEL;
    path = url.pathname;
  } catch {
    // A relative or bare specifier: split the text itself, without any query
    // or fragment, which are not part of the module's name.
    path = path.replace(/[?#].*$/s, '');
  }
  // A specifier ending in a separator names a directory, not a module: its
  // last segment would be a directory name (a user's home, say), so none is
  // taken.
  if (/[/\\]$/.test(path)) return FALLBACK_LABEL;
  const segments = path.split(/[/\\]/).filter((segment) => segment !== '');
  let name = segments[segments.length - 1] ?? '';
  try {
    name = decodeURIComponent(name);
  } catch {
    // A malformed escape is kept as written, then sanitized below.
  }
  const dot = name.lastIndexOf('.');
  if (dot > 0) name = name.slice(0, dot);
  const label = name.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, MAX_LABEL_LENGTH);
  return label === '' ? FALLBACK_LABEL : label;
}

/**
 * Refuses an explicit label that is not 1–64 characters of `[A-Za-z0-9_.-]`.
 *
 * @param label - The configured value
 * @param where - The option path, for the error message
 * @throws {RangeError} When the label has the wrong shape
 */
export function assertTaskLabel(label: unknown, where: string): asserts label is string {
  if (typeof label !== 'string' || !LABEL_PATTERN.test(label)) {
    throw new RangeError(
      `${where} must be 1-64 characters of letters, digits, '_', '.' or '-'; ` +
        `received ${typeof label === 'string' ? JSON.stringify(label) : typeof label}`,
    );
  }
}

/**
 * Assigns each specifier one label, once, on first sight. Explicit labels are
 * reserved up front; a derived label already held by another specifier gets
 * `_2`, `_3`, … so two same-named modules never overwrite each other's series,
 * and `onCollision` is told once per renamed specifier.
 */
export class TaskLabels {
  readonly #bySpecifier = new Map<string, string>();
  readonly #taken = new Set<string>();
  readonly #onCollision: (specifier: string, label: string) => void;

  /**
   * @param explicit - Validated `pools[specifier].label` values; unique
   * @param onCollision - Receives a specifier whose derived label was taken,
   * and the label it got instead
   */
  constructor(
    explicit: ReadonlyMap<string, string>,
    onCollision: (specifier: string, label: string) => void,
  ) {
    for (const [specifier, label] of explicit) {
      this.#bySpecifier.set(specifier, label);
      this.#taken.add(label);
    }
    this.#onCollision = onCollision;
  }

  /**
   * The label for `specifier`, assigning one on first sight.
   *
   * @param specifier - The task-module specifier
   * @returns Its label
   */
  labelOf(specifier: string): string {
    const known = this.#bySpecifier.get(specifier);
    if (known !== undefined) return known;
    const base = deriveTaskLabel(specifier);
    let label = base;
    for (let n = 2; this.#taken.has(label); n++) {
      const suffix = `_${n}`;
      label = base.slice(0, MAX_LABEL_LENGTH - suffix.length) + suffix;
    }
    this.#bySpecifier.set(specifier, label);
    this.#taken.add(label);
    if (label !== base) this.#onCollision(specifier, label);
    return label;
  }
}
