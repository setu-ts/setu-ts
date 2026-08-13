/** Dotenv flag validation shared by project and workspace-member scaffolding. */

/**
 * Renders the ConfigPlugin option literal for a generated dotenv path.
 *
 * One renderer, because a generated project reaches ConfigPlugin two ways — a
 * plugin wiring in the plugin list, and the `config` arm of a starter factory —
 * and the two disagreeing about `envFileOptional` would make the same project
 * boot from one template and not the other.
 *
 * `envFileOptional` is not a nicety. The emitted dotenv file is gitignored, so
 * it exists only on the machine that ran `setu new`; without this the project
 * throws at `ConfigPlugin.register` on every fresh clone, in CI, and inside a
 * container built from the repository.
 *
 * @param envFilePath - The project-relative dotenv path
 * @returns The option literal, without any enclosing braces of its own
 */
export function renderConfigOptions(envFilePath: string): string {
  return `{ envFilePath: '${envFilePath}', envFileOptional: true }`;
}

/** A parsed environment-file path. */
export type EnvFilePathResult =
  | { readonly ok: true; readonly path?: string }
  | { readonly ok: false; readonly message: string };

/** Reads a relative environment-file path without permitting a project escape. */
export function readEnvFilePath(
  flags: Readonly<Record<string, string | boolean | readonly string[]>>,
): EnvFilePathResult {
  const value = flags['env-file'];
  if (value === undefined) return { ok: true };
  if (typeof value !== 'string' || value === '') {
    return { ok: false, message: '--env-file needs a relative path.' };
  }
  if (
    value.startsWith('/') ||
    value.split('/').some((part) =>
      part === '' || part === '.' || part === '..' || !/^[A-Za-z0-9._-]+$/.test(part)
    )
  ) {
    return {
      ok: false,
      message: '--env-file must be a relative path inside the generated project.',
    };
  }
  return { ok: true, path: value };
}
