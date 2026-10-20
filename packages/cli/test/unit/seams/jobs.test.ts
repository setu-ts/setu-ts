import { describe, expect, it } from 'vitest';
import { JOBS_SEAM } from '../../../src/seams/jobs.ts';
import { deriveNames } from '../../../src/utils/names.ts';

describe('jobs seam', () => {
  it('imports processor factories and sorts the barrel entries', () => {
    expect(JOBS_SEAM.importSymbols(deriveNames('order-item'))).toEqual([
      'createOrderItemJobProcessor',
    ]);
    const barrel = JOBS_SEAM.renderBarrel({ job: ['zeta', 'alpha'] });
    expect(barrel).toContain('export const QUEUE_PROCESSORS: readonly QueueProcessorEntry[]');
    expect(barrel).toContain('createAlphaJobProcessor');
    expect(barrel).toContain('createZetaJobProcessor');
    expect(barrel.indexOf('createAlphaJobProcessor')).toBeLessThan(
      barrel.indexOf('createZetaJobProcessor'),
    );
    expect(barrel).not.toContain('new ');
  });
  it('declares an empty processor list on a fresh host', () => {
    expect(JOBS_SEAM.renderBarrel({})).toContain(
      'export const QUEUE_PROCESSORS: readonly QueueProcessorEntry[] = [];',
    );
  });
});
