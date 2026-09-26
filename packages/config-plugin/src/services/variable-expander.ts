/**
 * Variable expansion for a fully merged configuration snapshot.
 *
 * @module
 */

/** The same grammar the replacement below resolves. */
const REFERENCE_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * The optional expansion observation: `onExpanded` is called exactly once per
 * OBSERVED key whose already-loaded raw string contained the `${NAME}`
 * grammar, with the DISTINCT reference names in first-occurrence order. Only
 * a key in `keys` (the approved set) is ever scanned — an unapproved key's
 * string is expanded exactly as before and never inspected for provenance.
 * It observes grammar only — never a value — and a reference that fails to
 * resolve throws before the observer's result can matter, because a failed
 * load stores no provenance at all.
 *
 * @internal
 */
export interface ExpansionObserver {
  /** The exact approved keys; no other key is scanned or reported. */
  readonly keys: Pick<ReadonlySet<string>, 'has'>;
  /** Receives one observed key's distinct reference names. */
  readonly onExpanded: (key: string, references: readonly string[]) => void;
}

/**
 * Expands recursive `${NAME}` references against the final merged values.
 *
 * @param values - Final unexpanded configuration values
 * @param observer - Optional grammar observer (provenance evidence)
 * @returns A new record containing expanded values
 * @throws {Error} If a reference is missing or cyclic
 */
export function expandVariables(
  values: Readonly<Record<string, string>>,
  observer?: ExpansionObserver,
): Record<string, string> {
  const expanded: Record<string, string> = {};
  const resolving: string[] = [];

  const resolve = (key: string): string => {
    if (Object.hasOwn(expanded, key)) {
      return expanded[key];
    }

    const cycleStart = resolving.indexOf(key);
    if (cycleStart !== -1) {
      const cycle = [...resolving.slice(cycleStart), key].join(' -> ');
      throw new Error(`Cyclic configuration variable reference: ${cycle}.`);
    }

    const raw = values[key];
    if (raw === undefined) {
      throw new Error(`Configuration variable reference '${key}' is not defined.`);
    }

    resolving.push(key);
    const value = raw.replace(
      REFERENCE_PATTERN,
      (_match, reference: string) => resolve(reference),
    );
    resolving.pop();
    expanded[key] = value;
    if (observer !== undefined && observer.keys.has(key)) {
      // Distinct names in first-occurrence order — the memoized `resolve`
      // computes each key's expansion exactly once, so the observer fires
      // exactly once per grammatical key, including keys first reached as
      // someone else's reference.
      const references: string[] = [];
      for (const match of raw.matchAll(REFERENCE_PATTERN)) {
        const reference = match[1];
        if (!references.includes(reference)) {
          references.push(reference);
        }
      }
      if (references.length > 0) {
        observer.onExpanded(key, references);
      }
    }
    return value;
  };

  for (const key of Object.keys(values)) {
    resolve(key);
  }

  return expanded;
}
