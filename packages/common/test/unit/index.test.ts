import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES, none, ok, PLUGIN_PRIORITY, some } from '../../src/index.ts';

describe('@hono-enterprise/common barrel', () => {
  it('should export the capability token constants', () => {
    expect(CAPABILITIES.LOGGER).toBe('logger');
    expect(PLUGIN_PRIORITY.NORMAL).toBe(500);
  });

  it('should export the utility constructors', () => {
    expect(ok(1).success).toBe(true);
    expect(some(1).present).toBe(true);
    expect(none().present).toBe(false);
  });
});
