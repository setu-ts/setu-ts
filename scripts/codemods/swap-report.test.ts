import { describe, it, expect } from 'vitest';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tempDir } from '../../test/node-helpers.ts';
import { compareSwap, parseDenoLeaves, parseVitestReports, renderSwap, main } from './swap-report.ts';

const file = 'packages/a/test/unit/a.test.ts'; const source = 'packages/a/src/a.ts';
describe('test-suite swap evidence', () => {
  it('counts nested and ignored leaves, without their parent summaries', () => {
    const log = `\u001b[32m./${file} => outer ... inner ... child ... ok (1ms)\u001b[0m\n./${file} => outer ... inner ... ok (2ms)\n./${file} => outer ... skipped ... ignored (0ms)\n./${file} => outer ... ok (2ms)\nnoise`;
    expect(parseDenoLeaves(log)).toEqual({ [file]: ['outer ... inner ... child', 'outer ... skipped'] });
  });
  it('includes skipped Vitest assertions and refuses duplicate collection', () => {
    const converted = parseVitestReports([{ testResults: [{ name: '/work/' + file, assertionResults: [{ fullName: 'one' }, { fullName: 'one' }] }, { name: '/work/test/root.test.ts', assertionResults: [] }] }], '/work');
    expect(converted[file]).toHaveLength(2);
    const report = compareSwap({ [file]: ['one'] }, converted, {}, {}, { gains: { [file]: 'registration' } });
    expect(report.failures).toContain(`${file}: duplicate registration`);
    expect(report.failures).toContain(`${file}: repeated collected names`);
  });
  it('fails lost leaves and an unclassified gain, and attributes an ignored-suite gain', () => {
    expect(compareSwap({ [file]: ['one', 'two'] }, { [file]: ['one'] }, {}, {}).failures).toEqual([`${file}: lost 1 leaf test(s)`]);
    expect(compareSwap({}, { [file]: ['one'] }, {}, {}).failures).toEqual([`${file}: unclassified gain of 1`]);
    expect(compareSwap({}, { [file]: ['one', 'two'] }, {}, {}, { fallback: { [file]: 1 }, gains: { [file]: 'deno-uncounted' } }).failures).toEqual([]);
  });
  it('lists each coverage drop with its owning member leaf counts and refuses missing coverage', () => {
    const report = compareSwap({ [file]: ['one'] }, { [file]: ['one'] }, { [source]: [100, 100, 100], 'packages/a/src/missing.ts': [100, 100, 100] }, { [source]: [91, 100, 100] });
    expect(report.drops).toEqual([{ file: source, before: [100, 100, 100], after: [91, 100, 100], deno: 1, node: 1 }]);
    expect(report.failures).toEqual(['packages/a/src/missing.ts: missing coverage row']);
    expect(renderSwap(report)).toContain('| 100 / 100 / 100 | 91 / 100 / 100 | 1 | 1 |');
    expect(renderSwap(compareSwap({}, {}, {}, {}))).toContain('Failures: **0**');
  });
  it('keeps a named Deno-only suite in the parity table', () => {
    const report = compareSwap({ [file]: ['one'] }, {}, {}, {}, { denoOnly: [file], denoLane: { [file]: ['one'] } });
    expect(report.counts).toEqual([{ file, deno: 1, node: 1 }]); expect(report.failures).toEqual([]);
    expect(compareSwap({ [file]: ['one'] }, {}, {}, {}, { denoOnly: [file] }).failures).toContain(`${file}: missing retained Deno collection`);
    expect(compareSwap({}, { [file]: ['added'] }, {}, {}, { gains: { [file]: 'added-proof' } }).failures).toEqual([]);
  });
  it('counts a leaf whose name carries a Unicode line separator', () => {
    const log = `./${file} => suite ... escapes ("a\u2028b") ... ok (1ms)\nrunning 1 test from ./${file}\nouter ...\n  step ("a\u2029b") ... ok (1ms)\nouter ... ok (1ms)`;
    expect(parseDenoLeaves(log)[file]).toEqual(['suite ... escapes ("a\u2028b")']);
    expect(parseDenoLeaves(log.split('\n').slice(1).join('\n'))[file]).toEqual(['outer ... step ("a\u2029b")']);
  });
  it('counts sequential Deno steps despite startup-banner output between their status lines', () => {
    const log = `running 1 test from ./${file}\nouter ...\n  nested ...\n    socket ...Listening on http://127.0.0.1:1234/\n ok (1ms)\n  nested ... ok (1ms)\n  ignored ... ignored (0ms)\nouter ... ok (1ms)`;
    expect(parseDenoLeaves(log)).toEqual({ [file]: ['outer ... nested ... socket', 'outer ... ignored'] });
  });
  it('writes a report from real reporter artifacts and returns a failing status on loss', async () => {
    const root = await tempDir();
    try {
      await mkdir(`${root}/coverage-node/a`, { recursive: true });
      await writeFile(`${root}/deno.log`, `./${file} => suite ... one ... ok (1ms)\n`);
      await writeFile(`${root}/baseline.json`, JSON.stringify({ [source]: [100, 100, 100] }));
      await writeFile(`${root}/options.json`, '{}');
      await writeFile(`${root}/coverage-node/a/tests.json`, JSON.stringify({ testResults: [{ name: `${root}/${file}`, assertionResults: [{ fullName: 'one' }] }] }));
      await writeFile(`${root}/coverage-node/a/coverage-summary.json`, JSON.stringify({ total: {}, [`${root}/${source}`]: { branches: { pct: 100 }, functions: { pct: 100 }, lines: { pct: 100 } } }));
      expect(main(['deno.log', 'baseline.json', 'options.json', 'report.md'], root)).toBe(0);
      expect(await readFile(`${root}/report.md`, 'utf8')).toContain('Failures: **0**');
      await writeFile(`${root}/coverage-node/a/tests.json`, JSON.stringify({ testResults: [] }));
      expect(main(['deno.log', 'baseline.json', 'options.json', 'report.md'], root)).toBe(1);
      expect(() => main([], root)).toThrow('Usage');
    } finally { await rm(root, { recursive: true }); }
  });
});

it('ends sequential collection at root suites and parallel reporter output', () => {
  const log = `running 1 test from ./${file}\nouter ...\n  child ... ok (1ms)\nrunning 1 test from ./test/root.test.ts\nroot ...\n  script ... ok (1ms)\n./packages/b/test/b.test.ts => parallel ... leaf ... ok (1ms)\nsummary ... ok (1ms)`;
  expect(parseDenoLeaves(log)).toEqual({ [file]: ['outer ... child'], 'packages/b/test/b.test.ts': ['parallel ... leaf'] });
});

it('preserves existing repeated case names while refusing increased multiplicity', () => {
  const baseline = { [file]: ['suite ... one', 'suite ... one'] };
  expect(compareSwap(baseline, { [file]: ['suite one', 'suite one', 'new'] }, {}, {}, { gains: { [file]: 'added-proof' } }).failures).toEqual([]);
  expect(compareSwap(baseline, { [file]: ['suite one', 'suite one', 'suite one'] }, {}, {}, { gains: { [file]: 'added-proof' } }).failures).toContain(`${file}: repeated collected names`);
});

it('counts genuinely repeated sequential leaves once per execution, without repeated status lines', () => {
  const log = `running 1 test from ./${file}\nsuite ...\n  same ...\noutput\n  same ... ok (1ms)\n  same ... ok (1ms)\n  split ...Listening\n ok (1ms)\n  split ... ok (1ms)\nsuite ... ok (2ms)`;
  expect(parseDenoLeaves(log)[file]).toEqual(['suite ... same', 'suite ... same', 'suite ... split', 'suite ... split']);
});

it('uses source-call fallback for an ignored suite summary that has no leaf output', () => {
  expect(compareSwap({ [file]: ['ignored suite'] }, { [file]: ['one', 'two'] }, {}, {}, { fallback: { [file]: 2 } }).counts).toEqual([{ file, deno: 2, node: 2 }]);
});
