/**
 * The kernel's published surface (M70g).
 *
 * This milestone changes route RESOLUTION and one diagnostic, and adds nothing to
 * the barrel: `wildcardSegmentCount`, `RouteEntry.wildcards` and `describeRouteOwner`
 * are internal to `src/router/`. A test that pins the surface is what makes that claim
 * checkable — dropping or adding a re-export otherwise passes `deno check`, the
 * coverage bar (a re-export file is covered merely by being loaded) and every other
 * test, because tests import the concrete modules rather than the barrel (the M56
 * defect class).
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import * as barrel from '../../src/index.ts';

describe('@setu-ts/kernel barrel', () => {
  it('exports exactly the documented runtime surface', () => {
    expect(Object.keys(barrel).sort()).toEqual(['createApplication']);
  });

  it('does not leak the router internals the tie-break is built from', async () => {
    // `Router`, its `RouteEntry` bookkeeping and the segment counters are
    // implementation: plugins reach routes through the contract's `listRoutes()`.
    const source = await Deno.readTextFile(new URL('../../src/index.ts', import.meta.url));
    for (const internal of ['Router', 'wildcardSegmentCount', 'staticSegmentCount', 'RouteEntry']) {
      expect(source).not.toContain(internal);
    }
  });
});
