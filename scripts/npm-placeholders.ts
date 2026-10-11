/** Generates README-only name placeholders; never publishes. @module */
import { PACKAGE_METADATA, type PackageMetadata } from './jsr-metadata.ts';
import { REPOSITORY_URL } from './npm-release-gate.ts';
import { PUBLISHED_PACKAGES } from './release-packages.ts';

/** Generates one manifest and README per release member, without executable content.
 * @throws {Error} When a member has no entry in the package metadata table.
 */
export function placeholderFiles(
  packages: readonly string[] = PUBLISHED_PACKAGES,
  metadata: Readonly<Record<string, PackageMetadata>> = PACKAGE_METADATA,
): ReadonlyMap<string, string> {
  const files = new Map<string, string>();
  for (const dir of packages) {
    const leaf = dir.split('/').at(-1) as string;
    const name = `@setu-ts/${leaf}`;
    const entry = Object.hasOwn(metadata, leaf) ? metadata[leaf] : undefined;
    if (entry === undefined) {
      throw new Error(`No package metadata for ${name}; add it to scripts/jsr-metadata.ts`);
    }
    const pkg = {
      name,
      version: '0.0.0-bootstrap.0',
      description: entry.description,
      license: 'MIT',
      repository: { type: 'git', url: REPOSITORY_URL, directory: dir },
      publishConfig: { access: 'public' },
    };
    files.set(`${leaf}/package.json`, `${JSON.stringify(pkg, null, 2)}\n`);
    files.set(
      `${leaf}/README.md`,
      `# ${name}\n\nThis version is a name placeholder. It contains no framework code.\nThe first real release is 0.9.0, published through GitHub Actions with npm provenance.\n`,
    );
  }
  return files;
}
