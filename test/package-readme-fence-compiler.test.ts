/**
 * Fence compiler for the package READMEs M70k rewrites.
 *
 * X8-8 found the storage README's Uploads example — the package's headline
 * feature — broken three ways at once: an option name that does not exist
 * (`maxFileSize`, whose compiler suggestion `maxFiles` means something else
 * entirely), a field name that does not exist (`file.contentType`), and a
 * `getUploadedFile(ctx, 'avatar')` the middleware's own fieldname filter
 * guaranteed would return `undefined`. The same example sat in `PUBLIC_API.md`.
 *
 * None of that was catchable, because M38's fence gate compiles the ten `docs/`
 * guides and NO package README. This closes that hole for the READMEs this
 * milestone is responsible for, using the SAME engine rather than a second
 * classifier that could disagree with it.
 *
 * Deliberately not all 40+ package READMEs: that surfaces a large pre-existing
 * backlog which belongs to M70n's documentation sweep, and mixing it in here
 * would bury a milestone's own changes. The list is the set a milestone
 * rewrote and therefore owns.
 *
 * M70i (X6-2/X7-1) folded `grpc-plugin` and `graphql-plugin` into THIS list
 * rather than shipping the separate `test/readme-fence-compiler.test.ts` it had
 * written in parallel. That file re-implemented fence extraction and
 * classification instead of reusing this engine — the second classifier this
 * gate's own rationale warns about, and the duplication AI_GUIDELINES §11.1
 * forbids. It was also measurably weaker: it found 1 compilable fence in the
 * grpc README and 3 in graphql where the engine finds 2 and 6, and FOUR of the
 * fences it never reached did not compile. One gate, one classifier, one list.
 *
 * Negative control: reintroducing `maxFileSize` into the storage README's
 * Uploads fence must fail this test.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import {
  assembleSource,
  classify,
  denoCheck,
  extractFences,
  TS_ALIASES,
} from './fixtures/snippets/fence-engine.ts';

const SCRATCH_DIR = '.tmp/package-readme-fences';

/**
 * The package READMEs this milestone rewrote, each with the number of
 * compilable Setu-TS fences it carries.
 *
 * The count is pinned so a fence added later cannot slip past unclassified —
 * the same protection the guide gate's inventory table gives.
 */
const READMES: Readonly<Record<string, number>> = {
  'packages/storage-plugin/README.md': 3,
  'packages/queue-plugin/README.md': 8,
  'packages/worker-pool-plugin/README.md': 3,
  'packages/grpc-plugin/README.md': 2,
  'packages/graphql-plugin/README.md': 6,
};

/** Reads every fence the engine would compile from one README. */
async function compilableFences(readme: string) {
  const markdown = await Deno.readTextFile(readme);
  return extractFences(readme, markdown)
    .filter((fence) => TS_ALIASES.has(fence.lang))
    .map((fence) => ({ fence, classified: classify(fence) }))
    .filter(({ classified }) =>
      classified.kind === 'compile-complete' || classified.kind === 'compile-fragment'
    );
}

describe('package README fences compile (X8-8, X6-2/X7-1)', () => {
  it('should carry the expected number of compilable fences per README', async () => {
    const counts: Record<string, number> = {};
    for (const readme of Object.keys(READMES)) {
      counts[readme] = (await compilableFences(readme)).length;
    }
    expect(counts).toEqual(READMES);
  });

  it('should compile every Setu-TS fence in every listed README', async () => {
    await Deno.mkdir(SCRATCH_DIR, { recursive: true });
    const failures: string[] = [];

    for (const readme of Object.keys(READMES)) {
      for (const { fence, classified } of await compilableFences(readme)) {
        const file = `${SCRATCH_DIR}/${readme.replaceAll('/', '_')}-${fence.index}.ts`;
        await Deno.writeTextFile(file, assembleSource(fence, classified));
        const { code, stderr } = await denoCheck(file);
        if (code !== 0) {
          failures.push(
            `${readme} fence #${fence.index} at line ${fence.line} ` +
              `(heading: "${fence.heading}") failed deno check (exit ${code}):\n${stderr}`,
          );
        }
      }
    }

    if (failures.length > 0) {
      throw new Error(
        `${failures.length} README fence(s) failed:\n\n${failures.join('\n\n---\n\n')}`,
      );
    }
  });
});
