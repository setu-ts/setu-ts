/**
 * Unit tests for the generate command.
 *
 * @module
 */

import { runGenerateCommand } from '../../src/commands/generate.ts';
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

// This is a basic smoke test for the generate command structure.
// More comprehensive tests would require mocking filesystem operations.

describe('generate command', () => {
  it('returns a number result', async () => {
    const result = await runGenerateCommand(['controller', 'user'], { dryRun: true });
    expect(typeof result).toBe('number');
  });
});
