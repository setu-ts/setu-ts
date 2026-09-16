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
  fenceExtension,
  TS_ALIASES,
  writeProjectStubs,
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
  // M93b: +4 for the integration-event producer/consumer, correlation,
  // dual-publish and domain-mapping examples.
  'packages/messaging-plugin/README.md': 10,
  // M89c: the tenant-in-a-behaviour recipe (`getRepositoryFor`) is the one new
  // fence — gated so it cannot ship uncompilable.
  'packages/multi-tenancy-plugin/README.md': 3,
  'packages/scheduler-plugin/README.md': 3,
  // M90i: +1 for the trace-propagation example.
  'packages/queue-plugin/README.md': 9,
  'packages/worker-pool-plugin/README.md': 3,
  'packages/grpc-plugin/README.md': 2,
  'packages/graphql-plugin/README.md': 6,
  // M70n: every README the documentation workstream touched, folded into this
  // gate rather than a second one (plan §3.16). Counts are pinned so a fence
  // added later cannot slip past unclassified.
  'packages/auth-plugin/README.md': 7,
  'packages/static-plugin/README.md': 3,
  // M94c: +1 for the escaping Hono-template `raw(csrfTokenField(ctx))` example.
  'packages/session-plugin/README.md': 11,
  'packages/audit-plugin/README.md': 3,
  'packages/common/README.md': 2,
  // M92: +1 for the @Render example.
  'packages/decorator-plugin/README.md': 4,
  // M92: the new package's README is born gated — usage, functional renderView,
  // the @Render decorator and the raw() opt-out.
  'packages/view-plugin/README.md': 6,
  'packages/validation-plugin/README.md': 2,
  'packages/sse-plugin/README.md': 6,
  'packages/websocket-plugin/README.md': 10,
  'packages/realtime-backplane-plugin/README.md': 3,
  'packages/resilience-plugin/README.md': 2,
  'packages/react-router-plugin/README.md': 4,
  'packages/starters/rest-starter/README.md': 7,
  'packages/starters/microservice-starter/README.md': 6,
  'packages/starters/full-stack-starter/README.md': 7,
  // v0.6.0 follow-up: half of the package READMEs had never had a single fence
  // compiled — the list only ever grew when a milestone happened to touch a
  // README, so `kernel`, `runtime`, `sdk`, `exceptions` and `testing` sat
  // unchecked. These are the ones that compiled clean once the harness stopped
  // producing false failures of its own; the nine still outstanding are named
  // in the ungated-coverage assertion below so the gap cannot be forgotten.
  'packages/cache-plugin/README.md': 2,
  'packages/config-plugin/README.md': 4,
  'packages/di-plugin/README.md': 2,
  'packages/exceptions/README.md': 2,
  'packages/feature-flags-plugin/README.md': 2,
  'packages/health-plugin/README.md': 2,
  'packages/http-security-plugin/README.md': 2,
  'packages/kernel/README.md': 2,
  'packages/logger-plugin/README.md': 3,
  'packages/mail-plugin/README.md': 2,
  'packages/metrics-plugin/README.md': 2,
  'packages/runtime/README.md': 3,
  'packages/sdk/README.md': 14,
  'packages/telemetry-plugin/README.md': 2,
  'packages/testing/README.md': 9,
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

/**
 * Package READMEs whose fences are NOT yet compiled, and why the list exists.
 *
 * Half the package READMEs were in neither list before v0.6.0 — the gated set
 * only ever grew when a milestone happened to touch a README, so `kernel`,
 * `runtime`, `sdk`, `exceptions` and `testing` had never had a single example
 * type-checked. That is how `mail-plugin` shipped a `subject` field its own
 * `MailTemplate` does not have, `di-plugin` documented `register(Class, …)`
 * against a `register(token: string, …)` signature, and `exceptions` told
 * readers to use `ctx.request.params` — the exact mistake M34's drift gate
 * caught in generated code.
 *
 * Each entry here is a KNOWN GAP, not an exemption: the assertion below
 * requires every package README to be in exactly one of the two lists, so a
 * new package cannot be silently uncovered and an entry cannot be dropped
 * from the gated set without becoming visible here.
 */
const UNGATED: readonly string[] = [
  'packages/cli/README.md',
  'packages/cloudflare-plugin/README.md',
  'packages/cqrs-plugin/README.md',
  'packages/database-plugin/README.md',
  'packages/events-plugin/README.md',
  'packages/notification-plugin/README.md',
  'packages/openapi-plugin/README.md',
  'packages/secrets-plugin/README.md',
  'packages/service-discovery-plugin/README.md',
];

/** Every package README on disk, so neither list can drift from reality. */
async function everyPackageReadme(): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    for await (const entry of Deno.readDir(dir)) {
      if (!entry.isDirectory) continue;
      const path = `${dir}/${entry.name}`;
      try {
        await Deno.stat(`${path}/README.md`);
        found.push(`${path}/README.md`);
      } catch {
        // no README here; a grouping directory such as packages/starters
      }
      if (depth > 0) await walk(path, depth - 1);
    }
  };
  // Deep enough for any nesting a package group introduces. At depth 1 a
  // README below `packages/<group>/<package>/` was in neither list AND
  // absent from `onDisk`, so the coverage assertion passed over it.
  await walk('packages', 4);
  return found.sort();
}

describe('package README fences compile (X8-8, X6-2/X7-1)', () => {
  it('should carry the expected number of compilable fences per README', async () => {
    // Pin the SIZE of the target list too: without this, deleting an entry
    // shrinks both sides of the equality below and the gate passes vacuously
    // (negative control §6.7 of the M70n plan).
    expect(Object.keys(READMES)).toHaveLength(39);

    // And pin the COVERAGE: every package README is gated or explicitly named
    // as a known gap. Half of them were in neither before v0.6.0, which is how
    // three READMEs shipped examples that could not compile.
    const onDisk = await everyPackageReadme();
    const accounted = [...Object.keys(READMES), ...UNGATED].sort();
    expect(accounted).toEqual(onDisk);

    const counts: Record<string, number> = {};
    for (const readme of Object.keys(READMES)) {
      counts[readme] = (await compilableFences(readme)).length;
    }
    expect(counts).toEqual(READMES);
  });

  it('carries no fence inside a blockquote, which the scanner cannot see', async () => {
    // `scanFences` reads a fence opener at the start of a line, so a fence
    // indented behind `> ` is invisible: `packages/testing/README.md` had one
    // in a callout, and the gate reported its other eight compiling while that
    // `createTestApp` example was checked by nothing. Cheaper to keep code out
    // of callouts than to teach every consumer of the scanner about them.
    const offenders: string[] = [];
    for (const readme of [...Object.keys(READMES), ...UNGATED]) {
      const source = await Deno.readTextFile(readme);
      if (/^>\s*```/m.test(source)) offenders.push(readme);
    }
    expect(offenders).toEqual([]);
  });

  it('should compile every Setu-TS fence in every listed README', async () => {
    await Deno.mkdir(SCRATCH_DIR, { recursive: true });
    await writeProjectStubs(SCRATCH_DIR);
    const failures: string[] = [];

    for (const readme of Object.keys(READMES)) {
      for (const { fence, classified } of await compilableFences(readme)) {
        const file = `${SCRATCH_DIR}/${readme.replaceAll('/', '_')}-${fence.index}` +
          `.${fenceExtension(fence.lang)}`;
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
