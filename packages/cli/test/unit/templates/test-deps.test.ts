/**
 * The test-dependency gate.
 *
 * `setu generate module` emits a `*.service.test.ts`, and M65 made that
 * schematic UNGATED — so every host can now produce that file, not just the
 * decorator-installing templates that happened to declare the two packages it
 * imports. A host that omits them scaffolds cleanly, generates cleanly, reports
 * `created …/widget.service.test.ts`, and then fails the first `deno test` a
 * developer runs on an import the CLI itself wrote. That is exactly the M58
 * defect, and it shipped again on the no-template and full-stack hosts because
 * nothing enforced the rule across hosts.
 *
 * This iterates the hosts rather than naming them, so a fifth template inherits
 * the check instead of needing to remember it.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { TEMPLATES } from '../../../src/constants.ts';
import { getTemplate, type TemplateHost } from '../../../src/templates/registry.ts';
import { MINIMAL_HOST } from '../../../src/templates/minimal.ts';
import { TEST_DEPENDENCY_MANIFEST } from '../../../src/templates/test-deps.ts';
import { testHarnessFor } from '../../../src/schematics/test-harness.ts';
import { TARGET_RUNTIMES } from '../../../src/constants.ts';

/** Every host a scaffolded project can be built from, named for the failure message. */
const HOSTS: readonly (readonly [name: string, host: TemplateHost])[] = [
  ['(no template)', MINIMAL_HOST],
  ...TEMPLATES.map((name) => {
    const template = getTemplate(name);
    if (template === undefined) throw new Error(`no template registered for ${name}`);
    return [name, template] as const;
  }),
];

describe('every host declares what the generated module test imports', () => {
  const packages = Object.keys(TEST_DEPENDENCY_MANIFEST.denoImports ?? {});

  it('covers both test packages, so the check is not vacuous', () => {
    expect(packages.sort()).toEqual(['@std/expect', '@std/testing']);
  });

  for (const [name, host] of HOSTS) {
    // Deno and Cloudflare Workers resolve through the import map.
    it(`declares them in the Deno import map — ${name}`, () => {
      for (const pkg of packages) {
        expect(host.manifest?.denoImports?.[pkg]).toBeDefined();
      }
    });

    // Node and Bun deliberately declare NEITHER, and asserting their absence is
    // the point rather than an omission. `@std/testing/bdd` reaches `Deno.test`
    // inside its own `_test_suite.js`, so a generated test importing it dies on
    // Bun with `ReferenceError: Deno is not defined` before any assertion runs —
    // observed, not inferred. Those targets emit `bun:test`/`node:test`, which
    // are built in, so declaring these two shipped dependencies that could only
    // fail.
    it(`declares no unusable npm alias for them — ${name}`, () => {
      for (const pkg of packages) {
        expect(host.manifest?.npmDevDependencies?.[pkg]).toBeUndefined();
      }
    });
  }

  // The property the removal above rests on: every runtime gets a harness it can
  // actually execute, and only the Deno-family ones need these packages.
  it('pairs the declared dependency with the runtimes that can use it', () => {
    for (const runtime of TARGET_RUNTIMES) {
      const harness = testHarnessFor(runtime);
      expect(harness.imports.includes('@std/'), runtime).toBe(harness.needsStdDeps);
    }
  });

  // Declaring an npm dev dependency must NOT be what gives a Deno project a
  // package.json — `npmBuildScript` is that marker. Conflating the two is what
  // M58 fixed, and adding these packages to every host is exactly the change
  // that would reintroduce it.
  it('gives no non-frontend host an npm build script', () => {
    for (const [name, host] of HOSTS) {
      if (name === 'full-stack') continue;
      expect(host.manifest?.npmBuild).toBeUndefined();
    }
  });

  // The full-stack template merges its own lists with the shared ones; a
  // spread written the wrong way round would silently drop one side.
  it('keeps the full-stack template its own dependencies as well', () => {
    const fullStack = getTemplate('full-stack')?.manifest;
    // The `~/` alias every emitted app module imports through.
    expect(fullStack?.denoImports?.['~/']).toBe('./app/');
    expect(fullStack?.npmDevDependencies?.['vite']).toBeDefined();
    expect(fullStack?.npmBuild?.script).toBe('react-router build');
  });
});
