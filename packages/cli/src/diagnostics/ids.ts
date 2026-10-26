/** Stable, append-only diagnostic identities. @module */
import type { Finding } from './diagnose.ts';

/** The id letter is the severity; unclassifiable wiring has its own identity. */
export const FINDING_IDS = {
  'artifact-skipped': 'setu.E001',
  'artifact-invalid': 'setu.E002',
  'barrel-drift': 'setu.E003',
  'barrel-unreadable': 'setu.E004',
  'manual-registration': 'setu.E005',
  unwired: { unwired: 'setu.E006', unclassifiable: 'setu.W001' },
  'module-skipped': 'setu.E007',
  'module-rejected': 'setu.E008',
  'module-inactive': 'setu.E009',
  'legacy-layout': 'setu.E010',
  'check-config-invalid': 'setu.E011',
  'no-config': 'setu.W002',
  'legacy-registrar': 'setu.W003',
  'silence-unmatched': 'setu.W004',
  'config-unreadable': 'setu.E012',
  'artifact-unreadable': 'setu.E013',
} as const;

/** Looks up an identity without parsing rendered prose. */
export function findingId(finding: Finding): string {
  return finding.kind === 'unwired'
    ? FINDING_IDS.unwired[finding.outcome]
    : FINDING_IDS[finding.kind];
}

/** The project-relative location used for sorting and path-specific silences. */
export function findingPath(finding: Finding): string {
  if ('path' in finding) return finding.path;
  if ('barrel' in finding) return finding.barrel;
  if (finding.kind === 'module-inactive') return `src/modules/${finding.module}`;
  if (finding.kind === 'legacy-layout') return 'src/routes';
  return finding.kind === 'silence-unmatched' ? '.setu-ts/check.json' : 'setu.config.ts';
}
