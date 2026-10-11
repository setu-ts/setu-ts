import { describe, expect, it } from 'vitest';

import { DEFAULT_SECRET_FIELD_PATTERNS } from '../../src/redaction/classification.ts';

describe('DEFAULT_SECRET_FIELD_PATTERNS', () => {
  it('uses the normalized authorization spelling without changing other field names', () => {
    expect(DEFAULT_SECRET_FIELD_PATTERNS).toContain('**.authorization');
    expect(DEFAULT_SECRET_FIELD_PATTERNS).not.toContain('**.Authorization');
  });
});
