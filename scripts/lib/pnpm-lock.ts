/** Reads pnpm lock streams, including pnpm 12's package-manager document. @module */
import { parseAllDocuments } from 'yaml';

/** The resolved-package data shared by release and drift consumers. */
export interface IPnpmResolvedLock {
  readonly lockfileVersion: string;
  readonly packages: Readonly<
    Record<string, { readonly resolution: { readonly integrity?: string } }>
  >;
}

/** Combines every document's locked packages; incompatible formats fail loudly. */
export function parsePnpmLock(source: string): IPnpmResolvedLock {
  let lockfileVersion: string | undefined;
  const packages: Record<string, { readonly resolution: { readonly integrity?: string } }> = {};
  const documents = parseAllDocuments(source);
  for (const document of documents) {
    if (document.errors.length > 0) throw document.errors[0];
    const value: unknown = document.toJS();
    if (
      typeof value !== 'object' ||
      value === null ||
      !('lockfileVersion' in value) ||
      typeof value.lockfileVersion !== 'string' ||
      value.lockfileVersion === ''
    ) {
      throw new Error('pnpm-lock.yaml: missing lockfileVersion');
    }
    if (lockfileVersion !== undefined && lockfileVersion !== value.lockfileVersion) {
      throw new Error('pnpm-lock.yaml: inconsistent lockfileVersion');
    }
    lockfileVersion = value.lockfileVersion;
    if (!('packages' in value)) continue;
    if (
      typeof value.packages !== 'object' ||
      value.packages === null ||
      Array.isArray(value.packages)
    ) {
      throw new Error('pnpm-lock.yaml: invalid packages');
    }
    for (const [name, entry] of Object.entries(value.packages)) {
      if (
        typeof entry !== 'object' ||
        entry === null ||
        !('resolution' in entry) ||
        typeof entry.resolution !== 'object' ||
        entry.resolution === null ||
        ('integrity' in entry.resolution && typeof entry.resolution.integrity !== 'string')
      ) {
        throw new Error(`pnpm-lock.yaml: invalid resolution for ${name}`);
      }
      const resolution =
        'integrity' in entry.resolution ? { integrity: entry.resolution.integrity as string } : {};
      if (
        Object.hasOwn(packages, name) &&
        JSON.stringify(packages[name]!.resolution) !== JSON.stringify(resolution)
      ) {
        throw new Error(`pnpm-lock.yaml: conflicting resolution for ${name}`);
      }
      Object.defineProperty(packages, name, {
        value: { resolution },
        enumerable: true,
        configurable: true,
      });
    }
  }
  if (lockfileVersion === undefined) throw new Error('pnpm-lock.yaml: empty lockfile');
  return { lockfileVersion, packages };
}
