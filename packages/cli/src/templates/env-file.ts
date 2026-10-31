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

/**
 * Whether the generated container rules keep a dotenv file out of an image.
 *
 * The generated `.dockerignore` covers exactly `.env` and `.env.*` names. It
 * additionally KEEPS `.env.example` (it is committed and meant to be visible),
 * so this returns `false` for it — not because it is a secret, but because the
 * generic dotenv rules deliberately exclude it from what they match.
 *
 * A custom `--env-file` name such as `local.env` or `secrets` is not covered and
 * must be added to `.dockerignore` by hand.
 *
 * @param name - The final path segment of a dotenv file
 * @returns Whether `.env`/`.env.*` rules match it
 */
export function isCoveredDotenvName(name: string): boolean {
  return (
    name === '.env' ||
    (name.startsWith('.env.') && name.length > '.env.'.length && name !== '.env.example')
  );
}

/** A parsed environment-file path. */
export type EnvFilePathResult =
  { readonly ok: true; readonly path?: string } | { readonly ok: false; readonly message: string };

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
    value
      .split('/')
      .some(
        (part) => part === '' || part === '.' || part === '..' || !/^[A-Za-z0-9._-]+$/.test(part),
      )
  ) {
    return {
      ok: false,
      message: '--env-file must be a relative path inside the generated project.',
    };
  }
  return { ok: true, path: value };
}

/**
 * The dotenv path a configuration declares, when it declares a valid one.
 *
 * One reader for the devtool's approved-key scan and for `setu adopt`, so a
 * project cannot name one path to the tooling and a different one to the
 * conversion. Validation is {@linkcode readEnvFilePath}'s, so an absolute path,
 * an empty or `.`/`..` segment, or a character outside the accepted set makes
 * the declaration unusable rather than moving a file somewhere unexpected.
 *
 * @param configSource - The project's `setu.config.ts` text
 * @returns The validated relative path, or `undefined` when none is declared or it is unusable
 */
export function configuredEnvFilePath(configSource: string): string | undefined {
  // Either quote style: a formatter configured for double quotes rewrites the
  // generated single-quoted literal, and the app still reads the same file.
  const configured = /\benvFilePath:\s*(?:'([^']+)'|"([^"]+)")/.exec(configSource);
  const path = configured?.[1] ?? configured?.[2];
  if (path === undefined) return undefined;
  const parsed = readEnvFilePath({ 'env-file': path });
  return parsed.ok ? parsed.path : undefined;
}
