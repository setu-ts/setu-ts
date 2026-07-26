/**
 * SubdomainResolver tests.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { assertSome } from '../fixtures/option.ts';
import {
  extractSubdomainTenant,
  SubdomainResolver,
} from '../../src/resolvers/subdomain-resolver.ts';
import { createFakeRequest } from '../fixtures/fake-request.ts';

describe('subdomain resolver', () => {
  describe('without a configured baseDomain', () => {
    it('extracts the first label of a multi-label host', async () => {
      const resolver = new SubdomainResolver();
      const result = await resolver.resolve(
        createFakeRequest({ url: 'https://acme.example.com/path' }),
      );
      assertSome(result);
      expect(result.value.id).toEqual('acme');
    });

    it('treats `www` as an ordinary tenant label', async () => {
      const resolver = new SubdomainResolver();
      const result = await resolver.resolve(
        createFakeRequest({ url: 'https://www.example.com/path' }),
      );
      assertSome(result);
      expect(result.value.id).toEqual('www');
    });

    it('returns none for a single-label host', async () => {
      const resolver = new SubdomainResolver();
      const result = await resolver.resolve(
        createFakeRequest({ url: 'http://localhost:3000/path' }),
      );
      expect(result.present).toBe(false);
    });

    it('returns none when the first label is empty', async () => {
      const resolver = new SubdomainResolver();
      const result = await resolver.resolve(
        createFakeRequest({ url: 'https://.example.com/path' }),
      );
      expect(result.present).toBe(false);
    });

    it('returns none for a malformed URL', async () => {
      const resolver = new SubdomainResolver();
      const result = await resolver.resolve(
        createFakeRequest({ url: 'not-a-valid-url-without-protocol' }),
      );
      expect(result.present).toBe(false);
    });
  });

  describe('with a configured baseDomain (constrains resolution)', () => {
    it('resolves a strict subdomain of the base domain', async () => {
      const resolver = new SubdomainResolver({ baseDomain: 'example.com' });
      const result = await resolver.resolve(
        createFakeRequest({ url: 'https://acme.example.com/path' }),
      );
      assertSome(result);
      expect(result.value.id).toEqual('acme');
    });

    it('resolves the left-most label of a deep subdomain', async () => {
      const resolver = new SubdomainResolver({ baseDomain: 'example.com' });
      const result = await resolver.resolve(
        createFakeRequest({ url: 'https://acme.eu.example.com/path' }),
      );
      assertSome(result);
      expect(result.value.id).toEqual('acme');
    });

    it('ignores a port on the host', async () => {
      const resolver = new SubdomainResolver({ baseDomain: 'example.com' });
      const result = await resolver.resolve(
        createFakeRequest({ url: 'https://acme.example.com:8443/path' }),
      );
      assertSome(result);
      expect(result.value.id).toEqual('acme');
    });

    it('returns none for the apex domain itself — it carries no tenant', async () => {
      const resolver = new SubdomainResolver({ baseDomain: 'example.com' });
      const result = await resolver.resolve(
        createFakeRequest({ url: 'https://example.com/path' }),
      );
      expect(result.present).toBe(false);
    });

    it('returns none for a host outside the base domain', async () => {
      // Regression: this previously resolved tenant `evil`, so a request to an
      // unrelated domain silently acted as a tenant.
      const resolver = new SubdomainResolver({ baseDomain: 'example.com' });
      for (const url of ['https://evil.com/x', 'https://attacker.evil.com/x']) {
        const result = await resolver.resolve(createFakeRequest({ url }));
        expect(result.present).toBe(false);
      }
    });

    it('returns none for a host that merely suffix-matches without a dot', async () => {
      // `notexample.com`.endsWith('example.com') is true — the leading dot in
      // the comparison is what stops this from resolving tenant `notexample`.
      const resolver = new SubdomainResolver({ baseDomain: 'example.com' });
      const result = await resolver.resolve(
        createFakeRequest({ url: 'https://notexample.com/x' }),
      );
      expect(result.present).toBe(false);
    });
  });

  describe('extractSubdomainTenant (decidable core)', () => {
    it('returns null for an empty host', () => {
      expect(extractSubdomainTenant('')).toBe(null);
    });

    it('returns null when the host is only a port', () => {
      expect(extractSubdomainTenant(':8080')).toBe(null);
    });

    it('treats an empty baseDomain as unconfigured', () => {
      expect(extractSubdomainTenant('acme.example.com', '')).toEqual('acme');
    });

    it('returns null when the label before the base domain is empty', () => {
      expect(extractSubdomainTenant('.example.com', 'example.com')).toBe(null);
    });
  });
});
