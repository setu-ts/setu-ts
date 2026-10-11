import { describe, expect, it } from 'vitest';

import { assumePortAvailable } from '../../../src/workspace/port-probe.ts';

describe('assumePortAvailable', () => {
  it('keeps command tests and embedded callers non-networked by default', async () => {
    expect(await assumePortAvailable(3000)).toBe(true);
  });
});
