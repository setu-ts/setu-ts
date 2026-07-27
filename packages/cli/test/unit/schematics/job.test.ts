/**
 * Unit tests for the job schematic (ungated).
 *
 * @module
 */

import { deriveNames } from '../../../src/utils/names.ts';
import { generateJob } from '../../../src/schematics/job.ts';
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

describe('generateJob', () => {
  it('emits a job file with execute method', () => {
    const names = deriveNames('email-notification');
    const options = { runtime: {} as unknown, plugins: new Set<string>() };
    const files = generateJob(names, options);

    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('src/jobs/email-notification.job.ts');
    expect(files[0].contents).toContain('EmailNotificationJob');
    expect(files[0].contents).toContain('execute()');
  });
});
