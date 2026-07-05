/**
 * ConfigValidator — validates configuration against a structural schema.
 *
 * Accepts a schema object with a `parse(input: unknown): T` method compatible
 * with Zod's API. The schema's `parse()` is called once at startup after
 * merging and expansion, and the parsed output is stored as the configuration
 * snapshot. This preserves Zod coercions and defaults.
 *
 * @module
 */

/**
 * Minimal structural schema interface compatible with Zod's `parse(unknown)`
 * API. Consumers supply a Zod schema without `config-plugin` depending on Zod.
 *
 * @typeParam T - The parsed output type
 * @since 0.1.0
 */
export interface StructuralSchema<T> {
  /**
   * Parses and validates the input, applying coercions and defaults.
   *
   * @param input - The raw input to validate
   * @returns The validated and coerced output
   * @throws On validation failure
   */
  parse(input: unknown): T;
}

/**
 * Validates the raw configuration against the provided schema and returns the
 * validated output.
 *
 * The parsed output must be a non-null, non-array object.
 *
 * @param raw - The raw configuration (string values from env/files)
 * @param schema - The structural schema
 * @returns The validated configuration record
 * @throws {Error} If validation fails or the output is not an object
 */
export function validateConfig(
  raw: Readonly<Record<string, string>>,
  schema: StructuralSchema<unknown>,
): Record<string, unknown> {
  let parsed: unknown;

  try {
    parsed = schema.parse(raw);
  } catch {
    // Schema errors may include configuration values (for example invalid
    // enum input). Never propagate their message or cause across this boundary.
    throw new Error('Configuration validation failed.');
  }

  // Require the parsed output to be a non-null, non-array object.
  if (parsed === null || parsed === undefined) {
    throw new Error(
      'Configuration validation failed: schema output must be a non-null object.',
    );
  }

  if (Array.isArray(parsed)) {
    throw new Error(
      'Configuration validation failed: schema output must not be an array; ' +
        'use z.object({ ... }) for configuration schemas.',
    );
  }

  if (typeof parsed !== 'object') {
    throw new Error(
      'Configuration validation failed: schema output must be an object.',
    );
  }

  // Convert to a plain record (Zod returns the exact shape, which is an object).
  return parsed as Record<string, unknown>;
}
