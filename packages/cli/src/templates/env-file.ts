/** Dotenv flag validation shared by project and workspace-member scaffolding. */

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
