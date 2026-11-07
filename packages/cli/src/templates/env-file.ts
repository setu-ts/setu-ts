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
 * What a configuration's `envFilePath` property says, read without executing it.
 *
 * - `paths`: one string literal, or an array of string literals, each valid by
 *   {@linkcode readEnvFilePath}. ConfigPlugin loads them in order and an earlier
 *   file overrides a later one.
 * - `absent`: no active `envFilePath` property, so ConfigPlugin loads no file.
 * - `unreadable`: the property exists but is a variable, a call, a template
 *   literal or an invalid path, so the CLI cannot tell which file the app reads.
 *
 * Only an active property counts: comments are dropped and string literals are
 * opaque, so a commented-out declaration (`// envFilePath: 'old.env'`) or one
 * inside a string (`"envFilePath: 'x'"`) never wins over the real one. Either
 * quote style is read, for a value and for the key, because a formatter can
 * rewrite the generated single-quoted literal. A regular-expression literal is
 * outside what this reader classifies, as for the CLI's other config readers.
 *
 * @param configSource - The project's `setu.config.ts` text
 * @returns The declaration's kind, with its validated paths when it has them
 */
export function envFileDeclaration(
  configSource: string,
):
  | { readonly kind: 'paths'; readonly paths: readonly string[] }
  | { readonly kind: 'absent' | 'unreadable' } {
  const { code, literals } = scanSource(configSource);
  const quoted = (placeholder: string): string | undefined => {
    const literal = literals[Number(placeholder)];
    return literal !== undefined && /^(['"])[^'"\\]+\1$/.test(literal)
      ? literal.slice(1, -1)
      : undefined;
  };
  const key = /(?:\benvFilePath|\uE000(\d+)\uE000)\s*:\s*/g;
  for (let found = key.exec(code); found !== null; found = key.exec(code)) {
    if (found[1] !== undefined && quoted(found[1]) !== 'envFilePath') continue;
    // Sticky, read from where the key ended: no copy of the rest per key.
    const single = /\uE000(\d+)\uE000/y;
    const list = /\[\s*((?:\uE000\d+\uE000\s*,\s*)*\uE000\d+\uE000)\s*,?\s*\]/y;
    single.lastIndex = key.lastIndex;
    list.lastIndex = key.lastIndex;
    const one = single.exec(code);
    const many = list.exec(code);
    const placeholders =
      one !== null
        ? [one[1] as string]
        : many !== null
          ? [...(many[1] as string).matchAll(/\uE000(\d+)\uE000/g)].map((m) => m[1] as string)
          : [];
    const paths: string[] = [];
    for (const placeholder of placeholders) {
      const path = quoted(placeholder);
      const parsed = path === undefined ? undefined : readEnvFilePath({ 'env-file': path });
      const valid = parsed?.ok === true ? parsed.path : undefined;
      if (valid === undefined) return { kind: 'unreadable' };
      paths.push(valid);
    }
    return paths.length > 0 ? { kind: 'paths', paths } : { kind: 'unreadable' };
  }
  return { kind: 'absent' };
}

/**
 * The dotenv path a configuration declares, when it declares exactly one valid one.
 *
 * One reader for the devtool's approved-key scan and for `setu adopt`, so a
 * project cannot name one path to the tooling and a different one to the
 * conversion. Validation is {@linkcode readEnvFilePath}'s, so an absolute path,
 * an empty or `.`/`..` segment, or a character outside the accepted set makes
 * the declaration unusable rather than moving a file somewhere unexpected.
 *
 * @param configSource - The project's `setu.config.ts` text
 * @returns The validated relative path, or `undefined` when none, several, or an unusable one is declared
 */
export function configuredEnvFilePath(configSource: string): string | undefined {
  const declaration = envFileDeclaration(configSource);
  return declaration.kind === 'paths' && declaration.paths.length === 1
    ? declaration.paths[0]
    : undefined;
}

/**
 * The source's code with comments removed and each string literal replaced by
 * a `\uE000<n>\uE000` placeholder, plus the literals themselves (quotes
 * included) indexed by `n`. A `//` or `/*` inside a string is therefore not a
 * comment, and text inside a string is never matched as code. One linear pass;
 * a template literal is treated as a string up to its closing backtick.
 *
 * @param source - TypeScript source text
 * @returns The comment-free code and its string literals
 */
function scanSource(source: string): { code: string; literals: string[] } {
  let code = '';
  const literals: string[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index] as string;
    const next = source[index + 1];
    if (char === '/' && next === '/') {
      const end = source.indexOf('\n', index);
      index = end === -1 ? source.length : end;
    } else if (char === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      index = end === -1 ? source.length : end + 2;
    } else if (char === "'" || char === '"' || char === '`') {
      let end = index + 1;
      while (end < source.length && source[end] !== char) end += source[end] === '\\' ? 2 : 1;
      code += `\uE000${literals.length}\uE000`;
      literals.push(source.slice(index, end + 1));
      index = end + 1;
    } else {
      code += char;
      index += 1;
    }
  }
  return { code, literals };
}
