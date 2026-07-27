/**
 * Unit tests for the job schematic.
 *
 * @module
 */

import { deriveNames } from '../../../src/utils/names.ts';
import { generateJob } from '../../../src/schematics/job.ts';
import { createFakeRuntime } from '../../../test/fixtures/fake-runtime.ts';
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

describe('generateJob', () => {
  it('emits a job file with named handler', () => {
    const names = deriveNames('cleanup');
    const options = { runtime: createFakeRuntime(), plugins: new Set<string>() };
    const files = generateJob(names, options);

    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('src/jobs/cleanup.job.ts');
    expect(files[0].contents).toContain('CleanupJob');
  });

  it('includes the execute method', () => {
    const names = deriveNames('email');
    const options = { runtime: createFakeRuntime(), plugins: new Set<string>() };
    const files = generateJob(names, options);

    expect(files[0].contents).toContain('execute');
  });
});
