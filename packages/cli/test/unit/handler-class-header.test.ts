/**
 * V5-3 — a generated handler must satisfy the project's own `deno fmt --check`
 * whatever its artifact is called.
 *
 * The three CQRS/event schematics hand-wrapped their `implements` clause
 * UNCONDITIONALLY, so correctness depended on how long the name happened to
 * be: `find-order` joins to 92 characters and the formatter rejoins the wrap,
 * while `place-order` joins to 103 and the wrap is right. Same template, two
 * outcomes, decided by the caller's word. That is M63's D6 and M70h's X2-4
 * once more.
 *
 * The proof runs the REAL `deno fmt --check` against the emitted file under
 * the same `lineWidth` a scaffolded project ships with. A length-only
 * assertion cannot see this defect: every line of a wrongly-wrapped header is
 * comfortably under the width — it is the formatter's decision to REJOIN that
 * fails the check.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { generateQueryHandler } from '../../src/schematics/query-handler.ts';
import { generateCommandHandler } from '../../src/schematics/command-handler.ts';
import { generateEventHandler } from '../../src/schematics/event-handler.ts';
import {
  renderDeclarationHeader,
  renderMethodSignature,
} from '../../src/utils/render-declaration.ts';
import { deriveNames } from '../../src/utils/names.ts';
import { GENERATED_LINE_WIDTH, rootManifestSettings } from '../../src/templates/root-settings.ts';
import type { GeneratedFile, SchematicOptions } from '../../src/schematics/registry.ts';

/** Names either side of every schematic's wrap boundary. */
const NAMES = [
  'x',
  'find-order',
  'place-order',
  'order-summary',
  'outbound-payment-reconciliation',
] as const;

const OPTIONS: SchematicOptions = {
  runtime: 'deno',
  plugins: new Set(['cqrs-plugin', 'events-plugin']),
  now: () => 0,
};

type Generator = (
  names: ReturnType<typeof deriveNames>,
  o: SchematicOptions,
) => readonly GeneratedFile[];

const GENERATORS: ReadonlyArray<readonly [string, Generator]> = [
  ['query-handler', generateQueryHandler],
  ['command-handler', generateCommandHandler],
  ['event-handler', generateEventHandler],
];

/**
 * Writes the emitted files into a throwaway project carrying the same `fmt`
 * settings a scaffolded one gets, and reports whether `deno fmt --check`
 * accepts them unchanged.
 */
async function fmtAccepts(files: readonly GeneratedFile[]): Promise<{ ok: boolean; out: string }> {
  const dir = await Deno.makeTempDir({ prefix: 'v5-3-' });
  try {
    await Deno.writeTextFile(
      `${dir}/deno.json`,
      `${JSON.stringify(rootManifestSettings(), null, 2)}\n`,
    );
    for (const file of files) {
      const path = `${dir}/${file.path}`;
      await Deno.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
      await Deno.writeTextFile(path, file.contents);
    }
    const cmd = new Deno.Command('deno', {
      args: ['fmt', '--check'],
      cwd: dir,
      stdout: 'piped',
      stderr: 'piped',
    });
    const result = await cmd.output();
    return {
      ok: result.success,
      out: new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr),
    };
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

describe('generated handlers satisfy the project formatter at any name length', () => {
  for (const [schematic, generate] of GENERATORS) {
    for (const name of NAMES) {
      it(`${schematic} · ${name}`, async () => {
        const files = generate(deriveNames(name), OPTIONS);
        const { ok, out } = await fmtAccepts(files);
        expect(ok, out).toBe(true);
      });
    }
  }
});

describe('renderDeclarationHeader', () => {
  it('keeps a header that fits on one line', () => {
    const header = renderDeclarationHeader(
      'export class FindOrderQueryHandler',
      'implements IQueryHandler<A, B>',
    );
    expect(header).toBe('export class FindOrderQueryHandler implements IQueryHandler<A, B> {');
    expect(header).not.toContain('\n');
  });

  it('moves the clause to its own line when the one-line form overflows', () => {
    // Form two: the clause fits at a two-space indent.
    const clause = `implements IQueryHandler<${'A'.repeat(30)}, ${'B'.repeat(30)}>`;
    const header = renderDeclarationHeader('export class LongQueryHandler', clause);
    expect(header).toBe(`export class LongQueryHandler\n  ${clause} {`);
    expect(header.split('\n')[1]?.length).toBeLessThanOrEqual(GENERATED_LINE_WIDTH);
  });

  it('splits the keyword from the type when even that line overflows', () => {
    // Form three, and it is REACHED by a realistic artifact name rather than
    // being defensive padding: `outbound-payment-reconciliation` puts a
    // two-type generic past the width even at a two-space indent.
    const type = `ICommandHandler<${'A'.repeat(50)}, ${'B'.repeat(50)}>`;
    const header = renderDeclarationHeader('export class C', `implements ${type}`);
    expect(header).toBe(`export class C\n  implements\n    ${type} {`);
  });

  it('serves an interface declaration from the same implementation', () => {
    // Both shapes overflowed, so both go through one renderer rather than a
    // second copy with a different keyword baked in.
    const clause = `extends CqrsQuery<${'C'.repeat(60)}>`;
    expect(renderDeclarationHeader('export interface Short', 'extends CqrsQuery<A>'))
      .toBe('export interface Short extends CqrsQuery<A> {');
    expect(renderDeclarationHeader('export interface Long', clause))
      .toBe(`export interface Long\n  ${clause} {`);
  });

  it('joins at exactly the width and wraps one character past it', () => {
    // The boundary itself, since an off-by-one here is the whole defect.
    // The fixed cost is MEASURED from the renderer rather than counted by
    // hand, so the case stays on the boundary if the template ever changes.
    const fixed = renderDeclarationHeader('export class C', '').length;
    const build = (clauseLength: number): string =>
      renderDeclarationHeader('export class C', 'I'.repeat(clauseLength));
    const atWidth = build(GENERATED_LINE_WIDTH - fixed);
    const overWidth = build(GENERATED_LINE_WIDTH - fixed + 1);

    expect(atWidth).not.toContain('\n');
    expect(atWidth.length).toBe(GENERATED_LINE_WIDTH);
    expect(overWidth).toContain('\n');
  });
});

describe('renderMethodSignature', () => {
  it('keeps a signature that fits on one line', () => {
    expect(renderMethodSignature('handle', ['query: AQuery'], 'Promise<AView>'))
      .toBe('  handle(query: AQuery): Promise<AView> {');
  });

  it('expands the parameter list when the one-line form overflows', () => {
    const param = `command: ${'A'.repeat(60)}`;
    const ret = `Promise<${'B'.repeat(40)}>`;
    expect(renderMethodSignature('handle', [param], ret))
      .toBe(`  handle(\n    ${param},\n  ): ${ret} {`);
  });
});
