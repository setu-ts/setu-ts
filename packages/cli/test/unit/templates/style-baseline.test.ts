/**
 * M99e §3.7: the byte identity of every existing template's output.
 *
 * `template-baseline.json` was captured by the NAMED script
 * `test/fixtures/capture-template-baseline.ts` BEFORE any template change in
 * this milestone:
 *
 *   deno run --allow-read --allow-write packages/cli/test/fixtures/capture-template-baseline.ts
 *
 * It is regenerated only by that invocation and never edited by hand. This
 * test re-renders every (host, runtime) pair the script captured — through the
 * same `resolveHost` + `projectFiles` path the `new` command uses — and
 * asserts the file set and every hash match. A refactor of a renderer's
 * inputs cannot otherwise tell "unchanged" from "consistently different", and
 * the four existing templates are published output (M76's precedent).
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { TARGET_RUNTIMES, type TargetRuntime } from '../../../src/constants.ts';
import { projectFiles, resolveHost } from '../../../src/templates/project-files.ts';
import type { TemplateHost } from '../../../src/templates/registry.ts';
import {
  BASELINE_HOSTS,
  BASELINE_NAME,
  BASELINE_PAIRS,
  sha256Hex,
} from '../../fixtures/capture-template-baseline.ts';

const baseline = JSON.parse(
  await Deno.readTextFile(new URL('../../fixtures/template-baseline.json', import.meta.url)),
) as Record<string, Record<string, string>>;

/**
 * Renders one host for one runtime into the same `{ path: sha256 }` map the
 * capture script wrote, so the two are comparable field for field.
 *
 * @param host - The host to render
 * @param runtime - The runtime target to render for
 * @returns The per-file hash map
 */
async function render(
  host: TemplateHost,
  runtime: TargetRuntime,
): Promise<Record<string, string>> {
  const files = projectFiles(BASELINE_NAME, runtime, resolveHost(host, runtime));
  const hashes: Record<string, string> = {};
  for (const file of files) hashes[file.path] = await sha256Hex(file.contents);
  return hashes;
}

describe('template output is byte-identical to the pre-refactor baseline', () => {
  // The pair list is asserted, not just iterated: the capture script and this
  // test share one enumeration, but a hand-edited fixture that dropped a pair
  // would otherwise shrink the gate silently.
  it('pins exactly the pairs the capture script enumerated', () => {
    const expected = [
      ...TARGET_RUNTIMES.map((runtime) => `rest/${runtime}`),
      ...TARGET_RUNTIMES.map((runtime) => `microservice/${runtime}`),
      ...TARGET_RUNTIMES.map((runtime) => `class-based/${runtime}`),
      'minimal/deno',
    ];
    expect(BASELINE_PAIRS.map(([host, runtime]) => `${host}/${runtime}`)).toEqual(expected);
    expect(Object.keys(baseline).sort()).toEqual([...expected].sort());
  });

  for (const [hostName, runtime] of BASELINE_PAIRS) {
    it(`reproduces ${hostName} on ${runtime}`, async () => {
      const host = BASELINE_HOSTS[hostName];
      if (host === undefined) throw new Error(`Unknown baseline host: ${hostName}`);
      expect(await render(host, runtime)).toEqual(baseline[`${hostName}/${runtime}`]);
    });
  }

  // The negative control, committed rather than observed once: if the fixture
  // could not see a wiring-order change, it would bless a refactor that
  // reordered the plugin list. Reorder two of the rest set's wirings and
  // assert the render no longer matches — the hashes are what makes this
  // discriminating.
  it('discriminates: a reordered wiring changes the hashes', async () => {
    const rest = BASELINE_HOSTS['rest'];
    if (rest === undefined) throw new Error('Unknown baseline host: rest');
    const [a, b, ...remainder] = rest.plugins;
    const reordered: TemplateHost = { ...rest, plugins: [b, a, ...remainder] };
    expect(await render(reordered, 'deno')).not.toEqual(baseline['rest/deno']);
  });
});
