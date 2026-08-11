/**
 * Shared library members — the code two services in a workspace both need.
 *
 * The NestJS analogue is `nest g library`, and it was deferred until the
 * application case was proven. It is: M62 shipped a three-member workspace whose
 * services resolve and call each other.
 *
 * A library needs no wiring at all, and that was **measured rather than assumed**.
 * A Deno workspace member declaring `name` and `exports` is importable by every
 * sibling under exactly that name, with no import-map entry anywhere:
 *
 * ```ts
 * // apps/orders/src/…            libs/shared/deno.json → { "name": "@acme/shared" }
 * import { greeting } from '@acme/shared';
 * ```
 *
 * checked and RAN in a probe workspace. So there is no per-member manifest edit
 * here, which is what keeps this consistent with the milestone's promise that
 * adding to a workspace rewrites nothing the developer owns. The one thing that
 * can go wrong is the root's member glob, and a workspace created by this CLI
 * already declares `./libs/*` alongside `./apps/*` — a glob matching nothing is
 * valid, so both are written once at creation.
 *
 * Nothing is recorded in `setu.workspace.json` either. A library has no port and
 * is not a service: it must never appear in a discovery map or in the Compose
 * stack, and the directory plus the glob already are the record.
 *
 * @module
 */

import type { GeneratedFile } from '../utils/file-writer.ts';
import { joinPath } from '../utils/file-writer.ts';
import type { DerivedNames } from '../utils/names.ts';
import { workspaceProfile, type WorkspaceRuntimeProfile } from './runtime-profile.ts';

/** Where libraries live, relative to the workspace root. */
export const LIBS_DIR = 'libs';

/** The member glob that makes Deno treat a library as part of the workspace. */
export const LIBS_GLOB = `./${LIBS_DIR}/*`;

/**
 * The library's import specifier: `@<scope>/<name>`.
 *
 * Scoped because that is what Deno and JSR accept as a member name, and a bare
 * name would be indistinguishable from an npm package to a reader of the import.
 *
 * @param scope - The workspace scope, without the leading `@`
 * @param name - The library's kebab-case name
 * @returns The specifier siblings import it by
 */
export function librarySpecifier(scope: string, name: string): string {
  return `@${scope}/${name}`;
}

/**
 * Builds a library member's files.
 *
 * The example export is a pure function and the manifest pins no framework
 * package, deliberately: a library that imported `@setu-ts/common` for a type
 * nothing uses would ship a dead pin, and a developer who needs one adds it to
 * this manifest — the comment says so.
 *
 * @param scope - The workspace scope, without the leading `@`
 * @param names - The library's derived names
 * @returns The files to create, relative to the workspace root
 */
export function libraryFiles(
  scope: string,
  names: DerivedNames,
  profile: WorkspaceRuntimeProfile = workspaceProfile('deno'),
): readonly GeneratedFile[] {
  const specifier = librarySpecifier(scope, names.kebab);
  const root = joinPath(LIBS_DIR, names.kebab);
  const onDeno = profile.manifestKind === 'deno';

  // Two manifest shapes for one property. Both toolchains resolve a workspace
  // member by its declared NAME — measured under each — but they declare it in
  // different files, and a library carrying the wrong one is invisible to the
  // workspace that holds it.
  const manifest = onDeno
    ? {
      path: joinPath(root, 'deno.json'),
      contents: `${
        JSON.stringify(
          {
            name: specifier,
            version: '0.1.0',
            // Both required for a sibling to import it: `name` is the specifier
            // and `exports` is what that specifier resolves to. A member
            // declaring `name` without `exports` warns and resolves nothing.
            exports: { '.': './src/index.ts' },
            tasks: { test: 'deno test' },
            imports: {
              '@std/testing': 'jsr:@std/testing@^1.0.0',
              '@std/expect': 'jsr:@std/expect@^1.0.0',
            },
          },
          null,
          2,
        )
      }\n`,
    }
    : {
      path: joinPath(root, 'package.json'),
      contents: `${
        JSON.stringify(
          {
            name: specifier,
            version: '0.1.0',
            private: true,
            type: 'module',
            // `exports` for a modern resolver and `main` for anything older, both
            // pointing at the TypeScript source: the sibling that imports this is
            // itself run through a TypeScript runner, so there is no build step
            // between them.
            exports: { '.': './src/index.ts' },
            main: './src/index.ts',
            scripts: { test: profile.runtime === 'bun' ? 'bun test' : 'tsx --test test/*.ts' },
            ...(profile.runtime === 'bun'
              ? { devDependencies: { '@types/bun': '^1.2.0' } }
              : { devDependencies: { '@types/node': '^24.0.0', tsx: '^4.20.0' } }),
          },
          null,
          2,
        )
      }\n`,
    };

  const barrel = `/**
 * ${specifier} — code shared by this workspace's services.
 *
 * Import it from any member by name; the workspace resolves it, so no member
 * needs an entry for it:
 *
 * \`\`\`ts
 * import { ${names.camel} } from '${specifier}';
 * \`\`\`
 *
 * To use a framework package here, declare it in this library's own
 * \`${onDeno ? 'deno.json' : 'package.json'}\` — a member's dependencies do not
 * extend to the libraries it imports.
 *
 * @module
 */

/**
 * Replace this with something the services actually share.
 *
 * @param value - The value to describe
 * @returns A description of it
 */
export function ${names.camel}(value: string): string {
  return \`${names.kebab}: \${value}\`;
}
`;

  // Each toolchain's own runner, because a library must be testable with what its
  // workspace already installs: a `@std/testing` import in a Node library would
  // need a JSR dependency nothing else there uses.
  const test = onDeno
    ? `import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { ${names.camel} } from '../src/index.ts';

describe('${names.kebab}', () => {
  it('describes the value it is given', () => {
    expect(${names.camel}('x')).toBe('${names.kebab}: x');
  });
});
`
    : `import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ${names.camel} } from '../src/index.ts';

describe('${names.kebab}', () => {
  it('describes the value it is given', () => {
    assert.equal(${names.camel}('x'), '${names.kebab}: x');
  });
});
`;

  const readme = `# ${specifier}

Shared code for this workspace. Import it from any member:

\`\`\`ts
import { ${names.camel} } from '${specifier}';
\`\`\`

No wiring is needed: the workspace resolves a member by its declared \`name\`.

## Test

\`\`\`bash
${onDeno ? 'deno task test' : 'npm test'}
\`\`\`
`;

  return [
    manifest,
    { path: joinPath(root, 'src/index.ts'), contents: barrel },
    { path: joinPath(root, `test/${names.kebab}.test.ts`), contents: test },
    { path: joinPath(root, 'README.md'), contents: readme },
  ];
}
