// deno-lint-ignore-file require-await -- test fixtures use sync methods matching async interface signatures
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { securityHeadersMiddleware } from '../../src/middleware/security-headers-middleware.ts';
import { createFakeContext } from '../fixtures/fake-request-context.ts';

describe('securityHeadersMiddleware', () => {
  describe('default headers', () => {
    it('sets the four default security headers', async () => {
      const { ctx, nextCalled, response } = createFakeContext();
      const mw = securityHeadersMiddleware();
      await mw(ctx, async () => {
        nextCalled.push(true);
      });
      expect(nextCalled).toHaveLength(1);
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('x-frame-options')).toBe('DENY');
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
      expect(response.headers.get('strict-transport-security')).toBe(
        'max-age=31536000; includeSubDomains',
      );
    });

    it('CSP and Permissions-Policy are ABSENT by default', async () => {
      const { ctx, response } = createFakeContext();
      const mw = securityHeadersMiddleware();
      await mw(ctx, async () => {});
      expect(response.headers.get('content-security-policy')).toBeUndefined();
      expect(response.headers.get('permissions-policy')).toBeUndefined();
    });
  });

  describe('custom values override defaults', () => {
    it('custom xFrameOptions overrides default', async () => {
      const { ctx, response } = createFakeContext();
      const mw = securityHeadersMiddleware({ xFrameOptions: 'SAMEORIGIN' });
      await mw(ctx, async () => {});
      expect(response.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    });

    it('custom referrerPolicy overrides default', async () => {
      const { ctx, response } = createFakeContext();
      const mw = securityHeadersMiddleware({ referrerPolicy: 'strict-origin-when-cross-origin' });
      await mw(ctx, async () => {});
      expect(response.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    });
  });

  describe('per-header false omits the header', () => {
    it('xContentTypeOptions: false omits X-Content-Type-Options', async () => {
      const { ctx, response } = createFakeContext();
      const mw = securityHeadersMiddleware({ xContentTypeOptions: false });
      await mw(ctx, async () => {});
      expect(response.headers.get('x-content-type-options')).toBeUndefined();
    });

    it('xFrameOptions: false omits X-Frame-Options', async () => {
      const { ctx, response } = createFakeContext();
      const mw = securityHeadersMiddleware({ xFrameOptions: false });
      await mw(ctx, async () => {});
      expect(response.headers.get('x-frame-options')).toBeUndefined();
    });

    it('referrerPolicy: false omits Referrer-Policy', async () => {
      const { ctx, response } = createFakeContext();
      const mw = securityHeadersMiddleware({ referrerPolicy: false });
      await mw(ctx, async () => {});
      expect(response.headers.get('referrer-policy')).toBeUndefined();
    });

    it('strictTransportSecurity: false omits HSTS', async () => {
      const { ctx, response } = createFakeContext();
      const mw = securityHeadersMiddleware({ strictTransportSecurity: false });
      await mw(ctx, async () => {});
      expect(response.headers.get('strict-transport-security')).toBeUndefined();
    });
  });

  describe('enabled: false', () => {
    it('does not set any headers', async () => {
      const { ctx, nextCalled, response } = createFakeContext();
      const mw = securityHeadersMiddleware({ enabled: false });
      await mw(ctx, async () => {
        nextCalled.push(true);
      });
      expect(nextCalled).toHaveLength(1);
      expect(response.headers.get('x-content-type-options')).toBeUndefined();
      expect(response.headers.get('x-frame-options')).toBeUndefined();
      expect(response.headers.get('referrer-policy')).toBeUndefined();
      expect(response.headers.get('strict-transport-security')).toBeUndefined();
    });
  });

  describe('Content-Security-Policy', () => {
    it('sets CSP when configured', async () => {
      const { ctx, response } = createFakeContext();
      const mw = securityHeadersMiddleware({
        contentSecurityPolicy: {
          defaultSrc: "'self'",
          scriptSrc: "'self' https://cdn.example.com",
        },
      });
      await mw(ctx, async () => {});
      expect(response.headers.get('content-security-policy')).toBe(
        "default-src 'self'; script-src 'self' https://cdn.example.com",
      );
    });

    it('CSP: false omits CSP', async () => {
      const { ctx, response } = createFakeContext();
      const mw = securityHeadersMiddleware({ contentSecurityPolicy: false });
      await mw(ctx, async () => {});
      expect(response.headers.get('content-security-policy')).toBeUndefined();
    });
  });

  describe('Strict-Transport-Security', () => {
    it('custom HSTS options build correctly', async () => {
      const { ctx, response } = createFakeContext();
      const mw = securityHeadersMiddleware({
        strictTransportSecurity: {
          maxAge: 63072000,
          includeSubDomains: true,
          preload: true,
        },
      });
      await mw(ctx, async () => {});
      expect(response.headers.get('strict-transport-security')).toBe(
        'max-age=63072000; includeSubDomains; preload',
      );
    });

    it('HSTS with includeSubDomains: false', async () => {
      const { ctx, response } = createFakeContext();
      const mw = securityHeadersMiddleware({
        strictTransportSecurity: {
          maxAge: 31536000,
          includeSubDomains: false,
        },
      });
      await mw(ctx, async () => {});
      expect(response.headers.get('strict-transport-security')).toBe('max-age=31536000');
    });
  });

  describe('Permissions-Policy', () => {
    it('sets Permissions-Policy when configured', async () => {
      const { ctx, response } = createFakeContext();
      const mw = securityHeadersMiddleware({
        permissionsPolicy: 'camera=(), microphone=(), geolocation=()',
      });
      await mw(ctx, async () => {});
      expect(response.headers.get('permissions-policy')).toBe(
        'camera=(), microphone=(), geolocation=()',
      );
    });

    it('permissionsPolicy: false omits', async () => {
      const { ctx, response } = createFakeContext();
      const mw = securityHeadersMiddleware({ permissionsPolicy: false });
      await mw(ctx, async () => {});
      expect(response.headers.get('permissions-policy')).toBeUndefined();
    });
  });

  describe('headers persist after next()', () => {
    it('headers still present when downstream short-circuits', async () => {
      const { ctx, response } = createFakeContext();
      const mw = securityHeadersMiddleware();
      await mw(ctx, async () => {
        // Simulate downstream short-circuit
        ctx.response.status(403).json({ error: 'Forbidden' });
      });
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('x-frame-options')).toBe('DENY');
    });
  });
});
