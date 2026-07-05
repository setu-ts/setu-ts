/**
 * Variable expansion for a fully merged configuration snapshot.
 *
 * @module
 */

/**
 * Expands recursive `${NAME}` references against the final merged values.
 *
 * @param values - Final unexpanded configuration values
 * @returns A new record containing expanded values
 * @throws {Error} If a reference is missing or cyclic
 */
export function expandVariables(
  values: Readonly<Record<string, string>>,
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
      /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
      (_match, reference: string) => resolve(reference),
    );
    resolving.pop();
    expanded[key] = value;
    return value;
  };

  for (const key of Object.keys(values)) {
    resolve(key);
  }

  return expanded;
}
