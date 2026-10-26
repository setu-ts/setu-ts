import { expect, it } from 'vitest';
import { FINDING_IDS, findingId, findingPath } from '../../src/diagnostics/ids.ts';
import { CHECK_FINDINGS } from '../fixtures/check-findings.ts';

it('assigns exactly one unique stable id to each finding kind and wiring outcome', () => {
  const ids = Object.values(FINDING_IDS).flatMap((value) =>
    typeof value === 'string' ? [value] : Object.values(value),
  );
  expect(new Set(ids).size).toBe(17);
  expect(CHECK_FINDINGS.map(findingId).sort()).toEqual([...ids].sort());
  expect(ids).toEqual([
    'setu.E001',
    'setu.E002',
    'setu.E003',
    'setu.E004',
    'setu.E005',
    'setu.E006',
    'setu.W001',
    'setu.E007',
    'setu.E008',
    'setu.E009',
    'setu.E010',
    'setu.E011',
    'setu.W002',
    'setu.W003',
    'setu.W004',
    'setu.E012',
    'setu.E013',
  ]);
});

it('uses project-relative primary paths for path entries and ordering', () => {
  expect(CHECK_FINDINGS.map(findingPath)).toEqual([
    'src/controllers/bad.controller.ts',
    'src/controllers/Bad.controller.ts',
    'src/controllers/index.ts',
    'src/controllers/index.ts',
    'src/controllers/manual.controller.ts',
    'src/controllers/index.ts',
    'src/modules/orders',
    'src/modules/Bad',
    'src/modules/orders',
    'src/routes',
    '.setu-ts/check.json',
    'src/controllers/index.ts',
    'setu.config.ts',
    'setu.config.ts',
    '.setu-ts/check.json',
    'setu.config.ts',
    'src/controllers/huge.controller.ts',
  ]);
});
