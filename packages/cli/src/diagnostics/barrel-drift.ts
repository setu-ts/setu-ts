/** Set-based inspection of managed registration barrels. @module */
import type { IFileSystem } from '@setu-ts/common';
import type { SeamArtifacts, SeamSpec } from '../seams/seam-spec.ts';
import { maskComments, maskSourceCode } from '../devtool/sources.ts';
import { joinPath, MAX_EXISTING_FILE_BYTES } from '../utils/file-writer.ts';
import { isMissingPath } from '../utils/filesystem-errors.ts';
import type { Finding } from './diagnose.ts';

/** Reads only regular, bounded files; absence and unsafe evidence stay distinct. */
export async function readBarrel(
  fs: IFileSystem,
  path: string,
): Promise<
  | { readonly kind: 'absent' }
  | { readonly kind: 'source'; readonly source: string }
  | { readonly kind: 'unreadable'; readonly reason: 'not-a-file' | 'too-large' | 'unclassifiable' }
> {
  try {
    const stat = await fs.stat(path);
    if (!stat.isFile) return { kind: 'unreadable', reason: 'not-a-file' };
    if (stat.size > MAX_EXISTING_FILE_BYTES) return { kind: 'unreadable', reason: 'too-large' };
    return { kind: 'source', source: new TextDecoder().decode(await fs.readFile(path)) };
  } catch (cause) {
    return isMissingPath(cause)
      ? { kind: 'absent' }
      : { kind: 'unreadable', reason: 'unclassifiable' };
  }
}

/** Compares import/export specifier name sets, merging families sharing a barrel. */
export async function diagnoseBarrels(
  fs: IFileSystem,
  dir: string,
  specs: readonly SeamSpec[],
  artifacts: SeamArtifacts,
): Promise<readonly Finding[]> {
  const groups = new Map<string, SeamSpec[]>();
  for (const spec of specs) {
    if (spec.exports.length === 0) continue;
    groups.set(spec.barrel, [...(groups.get(spec.barrel) ?? []), spec]);
  }
  const findings: Finding[] = [];
  for (const [barrel, families] of groups) {
    const read = await readBarrel(fs, joinPath(dir, barrel));
    if (read.kind === 'unreadable') {
      findings.push({ kind: 'barrel-unreadable', barrel, reason: read.reason });
      continue;
    }
    const source = read.kind === 'absent' ? '' : maskComments(read.source);
    if (source === undefined) {
      findings.push({ kind: 'barrel-unreadable', barrel, reason: 'unclassifiable' });
      continue;
    }
    // Keep specifier literals for parsing, but require each declaration keyword
    // to occupy code in the string-masked view as well. A semicolon inside a
    // string must not turn import-looking prose into a stale artifact.
    const code = maskSourceCode(source) ?? '';
    const imports = [
      ...source.matchAll(
        /(?:^|[;\r\n])\s*(?:import|export)\s+(?:type\s+)?(?:\{[^}]*\}|\*(?:\s+as\s+[A-Za-z_$][\w$]*)?|[A-Za-z_$][\w$]*(?:\s*,\s*(?:\{[^}]*\}|\*\s+as\s+[A-Za-z_$][\w$]*))?)\s+from\s*(['"])([^'"\r\n]+)\1/g,
      ),
    ]
      .filter((match) => {
        const offset = match[0].search(/\b(?:import|export)\b/);
        return /^(?:import|export)\b/.test(code.slice(match.index + offset));
      })
      .map((match) => match[2]);
    const unlisted = new Set<string>();
    const stale = new Set<string>();
    for (const family of families) {
      const admitted = new Set(artifacts[family.schematic] ?? []);
      const listed = new Set(
        imports
          .filter(
            (path) =>
              path.startsWith('./') &&
              path.endsWith(family.suffix) &&
              path.length > family.suffix.length + 2,
          )
          .map((path) => path.slice(2, -family.suffix.length)),
      );
      for (const name of admitted)
        if (!listed.has(name)) unlisted.add(joinPath(family.dir, `${name}${family.suffix}`));
      for (const name of listed)
        if (!admitted.has(name)) stale.add(joinPath(family.dir, `${name}${family.suffix}`));
    }
    if (unlisted.size > 0 || stale.size > 0)
      findings.push({
        kind: 'barrel-drift',
        barrel,
        unlisted: [...unlisted].sort(),
        stale: [...stale].sort(),
      });
  }
  return findings;
}
