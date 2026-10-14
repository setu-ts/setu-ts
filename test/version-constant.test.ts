/**
 * The version constant agrees with both manifests (M111a plan §3.5).
 *
 * `src/version.ts` replaced the `deno.json` JSON import because that file is
 * not part of an npm tarball and the import left `rootDir`. The cost is a
 * third copy of the version, so this table — every member that ships the
 * constant — is the guard that `release:bump` moved all three together.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

/** Every workspace member directory, read from the root manifest. */
async function members(): Promise<string[]> {
  const root = JSON.parse(await Deno.readTextFile('deno.json')) as { workspace: string[] };
  return root.workspace.map((entry) => entry.replace(/^\.\//, ''));
}

/** The members that read their own version, which are the ones carrying the constant. */
async function membersWithConstant(): Promise<string[]> {
  const found: string[] = [];
  for (const dir of await members()) {
    const exists = await Deno.stat(`${dir}/src/version.ts`).then(
      () => true,
      () => false,
    );
    if (exists) found.push(dir);
  }
  return found;
}

describe('src/version.ts agrees with deno.json and package.json', () => {
  it('ships the constant on exactly the 44 members that read their version', async () => {
    // Plan §3.5: the seven that read none would carry dead surface.
    expect(await membersWithConstant()).toHaveLength(44);
  });

  it('every VERSION equals both manifest versions', async () => {
    const disagreements: string[] = [];
    for (const dir of await membersWithConstant()) {
      const { VERSION } = (await import(`../${dir}/src/version.ts`)) as { VERSION: string };
      const deno = JSON.parse(await Deno.readTextFile(`${dir}/deno.json`)).version;
      const npm = JSON.parse(await Deno.readTextFile(`${dir}/package.json`)).version;
      if (VERSION !== deno || VERSION !== npm) {
        disagreements.push(`${dir}: VERSION ${VERSION}, deno.json ${deno}, package.json ${npm}`);
      }
    }
    expect(disagreements).toEqual([]);
  });
});
