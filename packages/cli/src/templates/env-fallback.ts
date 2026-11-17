import { stringLiteral } from '../workspace/runtime-profile.ts';

/**
 * Renders an environment read that treats an empty value as unset.
 *
 * @param variable - The generated environment variable name
 * @param fallback - The value when absent or empty
 * @returns The runtime environment expression as source
 */
export function runtimeEnvRead(variable: string, fallback: string): string {
  return `runtime.env.${variable} || ${stringLiteral(fallback)}`;
}

/**
 * Rewrites a rendering's current environment reads to the nullish form every
 * release before M140b wrote, so a CLI-owned file from one of them is still
 * recognised as CLI-owned (and so rewritten, not reported as hand-edited).
 *
 * @param source - A current rendering
 * @param reads - Each read as its variable and fallback
 * @returns The same rendering with every listed read in the nullish form
 */
export function withNullishEnvReads(
  source: string,
  reads: readonly (readonly [variable: string, fallback: string])[],
): string {
  return reads.reduce(
    (text, [variable, fallback]) =>
      text.replaceAll(
        runtimeEnvRead(variable, fallback),
        `runtime.env.${variable} ?? ${stringLiteral(fallback)}`,
      ),
    source,
  );
}
