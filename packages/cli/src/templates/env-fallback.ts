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
