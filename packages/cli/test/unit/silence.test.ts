import { expect, it } from 'vitest';
import { readSilence } from '../../src/diagnostics/silence.ts';
import { createFakeFs } from '../fixtures/fake-fs.ts';
import { CHECK_FINDINGS } from '../fixtures/check-findings.ts';
import { MAX_EXISTING_FILE_BYTES } from '../../src/utils/file-writer.ts';

const path = '/app/.setu-ts/check.json';
it('leaves absent files alone and matches global and exact-path entries against original findings', async () => {
  expect(await readSilence(createFakeFs(), '/app', CHECK_FINDINGS)).toEqual({
    findings: CHECK_FINDINGS,
    silenced: 0,
  });
  const fs = createFakeFs({
    [path]: JSON.stringify({
      silence: [
        'setu.W001',
        { id: 'setu.E003', path: 'src/controllers/index.ts' },
        'setu.E003',
        'setu.W002',
      ],
    }),
  });
  const result = await readSilence(fs, '/app', CHECK_FINDINGS);
  expect(result.silenced).toBe(3);
  expect(result.findings).toEqual(
    CHECK_FINDINGS.filter(
      (f) =>
        f.kind !== 'barrel-drift' &&
        f.kind !== 'no-config' &&
        !(f.kind === 'unwired' && f.outcome === 'unclassifiable'),
    ),
  );
});

it('invalidates the entire file for every invalid shape and both unsilenceable ids', async () => {
  const values = [
    null,
    [],
    {},
    { silence: [], extra: true },
    { silence: 'setu.E003' },
    { silence: [false] },
    { silence: [null] },
    { silence: [4] },
    { silence: ['unknown'] },
    { silence: ['setu.E011'] },
    { silence: ['setu.W004'] },
    { silence: [{ id: 'setu.E003' }] },
    { silence: [{ id: 'setu.E003', path: 4 }] },
    { silence: [{ id: 'setu.E003', path: 'src/index.ts', extra: 1 }] },
    ...['', '/absolute', '../escape', './local', 'a//b', 'a\\b'].map((path) => ({
      silence: ['setu.E003', { id: 'setu.E003', path }],
    })),
  ];
  for (const value of values) {
    const result = await readSilence(
      createFakeFs({ [path]: JSON.stringify(value) }),
      '/app',
      CHECK_FINDINGS,
    );
    expect(result.silenced, JSON.stringify(value)).toBe(0);
    expect(result.findings.slice(0, -1)).toEqual(CHECK_FINDINGS);
    expect(result.findings.at(-1)).toMatchObject({
      kind: 'check-config-invalid',
      path: '.setu-ts/check.json',
    });
  }
  for (const seed of [
    { [path]: '{' },
    { [path]: ' '.repeat(MAX_EXISTING_FILE_BYTES + 1) },
    { [`${path}/child`]: '' },
  ])
    expect((await readSilence(createFakeFs(seed), '/app', [])).findings[0]?.kind).toBe(
      'check-config-invalid',
    );
});

it('reports unmatched ids and exact paths without suppressing errors elsewhere', async () => {
  const result = await readSilence(
    createFakeFs({
      [path]: JSON.stringify({ silence: ['setu.E010', { id: 'setu.E003', path: 'other.ts' }] }),
    }),
    '/app',
    [CHECK_FINDINGS[2]],
  );
  expect(result.silenced).toBe(0);
  expect(result.findings.map((f) => f.kind)).toEqual([
    'barrel-drift',
    'silence-unmatched',
    'silence-unmatched',
  ]);
});
