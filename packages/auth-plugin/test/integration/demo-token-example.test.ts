import { describe, expect, it } from 'vitest';
import { CAPABILITIES } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { AuthPlugin } from '../../src/index.ts';
import { DEMO_JWT_SECRET, issueDemoToken } from '../../../../apps/rest-api/src/auth/demo-token.ts';

describe('REST example token', () => {
  it('issues a five-minute token with the same key the example verifies', async () => {
    const app = createApplication({
      plugins: [RuntimePlugin(), AuthPlugin({ jwt: { secret: DEMO_JWT_SECRET } })],
    });
    await app.start();
    try {
      const token = await issueDemoToken(app);
      const claims = await app.services
        .get(CAPABILITIES.JWT)
        .verify<{ sub: string; iat: number; exp: number }>(token);
      expect(claims.sub).toBe('example-user');
      expect(claims.exp - claims.iat).toBe(300);
    } finally {
      await app.stop();
    }
  });
});
