/**
 * The SAML debug-log sanitizer: library messages can quote attacker-supplied
 * values, so control characters never reach a log line and length is capped.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { describeError } from '../../src/saml/routes.ts';

describe('describeError', () => {
  it('replaces control characters and caps the length', () => {
    expect(describeError(new Error('audience mismatch\r\nINFO forged\u0000'))).toBe(
      'audience mismatch  INFO forged ',
    );
    expect(describeError(new Error('x'.repeat(500)))).toHaveLength(200);
  });

  it('names a non-Error throw without quoting it', () => {
    expect(describeError('secret value')).toBe('non-error thrown');
  });
});
