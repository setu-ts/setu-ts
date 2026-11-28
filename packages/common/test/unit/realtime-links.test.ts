/**
 * The per-connection link seam a request-bound backplane implements.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';
import type { IRealtimeBackplane, IRealtimeLinkBackplane } from '../../src/index.ts';
import { hasConnectionLinks } from '../../src/index.ts';

const plain: IRealtimeBackplane = {
  origin: 'o',
  connect: () => Promise.resolve(),
  publish: () => Promise.resolve(),
  subscribe: () => Promise.resolve(() => {}),
  close: () => Promise.resolve(),
};

describe('hasConnectionLinks', () => {
  it('is true only when both link members are functions', () => {
    const linked: IRealtimeLinkBackplane = {
      ...plain,
      openConnectionLink: () => ({ publish: () => true, close: () => {} }),
      publishViaHub: () => Promise.resolve(),
    };
    expect(hasConnectionLinks(linked)).toBe(true);
    expect(hasConnectionLinks(plain)).toBe(false);
    expect(
      hasConnectionLinks({
        ...plain,
        openConnectionLink: linked.openConnectionLink,
      } as IRealtimeBackplane),
    ).toBe(false);
    expect(
      hasConnectionLinks({ ...plain, publishViaHub: 'no' } as unknown as IRealtimeBackplane),
    ).toBe(false);
  });
});
