/**
 * V12-52 — a backend URL with userinfo is refused with a fixed message.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';

import { credentialFreeUrl } from '../../src/url/url-credentials.ts';
import { DiscoveryUnavailableError } from '../../src/errors.ts';

const REFUSAL = 'fixed refusal';

describe('credentialFreeUrl', () => {
  it.each([
    ['username and password', 'http://ops:canary-pw-52@consul:8500'],
    ['username only', 'http://canary-user-52@consul:8500'],
    ['password only', 'http://:canary-pw-52@consul:8500'],
  ])('refuses a URL with %s, naming none of it', (_label, url) => {
    let caught: unknown;
    try {
      credentialFreeUrl(url, REFUSAL);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DiscoveryUnavailableError);
    expect((caught as Error).message).toBe(REFUSAL);
    expect(String(caught)).not.toContain('canary');
    expect((caught as Error).cause).toBeUndefined();
  });

  it('returns a URL without userinfo unchanged', () => {
    expect(credentialFreeUrl('https://consul:8500/', REFUSAL)).toBe('https://consul:8500/');
  });

  it('returns an unparsable value unchanged for the request path to report', () => {
    expect(credentialFreeUrl('not a url', REFUSAL)).toBe('not a url');
  });
});
