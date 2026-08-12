import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { assumePortAvailable } from '../../../src/workspace/port-probe.ts';

describe('assumePortAvailable', () => {
  it('keeps command tests and embedded callers non-networked by default', async () => {
    expect(await assumePortAvailable(3000)).toBe(true);
  });
});
