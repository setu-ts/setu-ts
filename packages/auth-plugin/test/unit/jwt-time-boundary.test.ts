import { describe, expect, it } from 'vitest';
import { JwtService } from '../../src/services/jwt-service.ts';
import { JwtVerifier } from '../../src/issuers/jwt-verifier.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';
import { generateTestKey, signToken } from '../fixtures/issuer-tokens.ts';

const BOUNDARY_MS = 1_700_000_100_000;

describe('first-party JWT time boundaries', () => {
  for (const fractionMs of [0, 500]) {
    const boundary = BOUNDARY_MS + fractionMs;
    for (const offset of [-1, 0, 1]) {
      it(`exp ${boundary}: ${offset} ms from expiry`, async () => {
        const runtime = createFakeRuntime(boundary - 1000);
        const service = new JwtService(runtime, {
          algorithm: 'HS256',
          secret: 'time-boundary-test-secret',
        });
        const token = await service.sign({ sub: 'user', exp: boundary / 1000 });
        runtime.setNow(boundary + offset);
        if (offset < 0) await expect(service.verify(token)).resolves.toMatchObject({ sub: 'user' });
        else await expect(service.verify(token)).rejects.toThrow('Token expired');
      });

      it(`nbf ${boundary}: ${offset} ms from validity`, async () => {
        const runtime = createFakeRuntime(boundary - 1000);
        const service = new JwtService(runtime, {
          algorithm: 'HS256',
          secret: 'time-boundary-test-secret',
        });
        const token = await service.sign({ sub: 'user', nbf: boundary / 1000 });
        runtime.setNow(boundary + offset);
        if (offset < 0) await expect(service.verify(token)).rejects.toThrow('Token not yet valid');
        else await expect(service.verify(token)).resolves.toMatchObject({ sub: 'user' });
      });
    }
  }
});

describe('outside-issuer JWT time boundaries', () => {
  for (const skew of [0, 30]) {
    for (const fractionMs of [0, 500]) {
      const boundary = BOUNDARY_MS + fractionMs;
      for (const offset of [-1, 0, 1]) {
        for (const claim of ['exp', 'nbf'] as const) {
          it(`${claim} with skew ${skew}, fractional ms ${fractionMs}: ${offset} ms from boundary`, async () => {
            const runtime = createFakeRuntime(boundary + offset);
            const key = await generateTestKey('ES256', 'time-key');
            const verifier = new JwtVerifier({
              runtime,
              keySet: { keys: () => Promise.resolve([key.jwk]) },
              algorithms: new Set(['ES256']),
              audience: 'api',
              clockToleranceSec: skew,
            });
            const payload =
              claim === 'exp'
                ? { sub: 'user', aud: 'api', exp: boundary / 1000 - skew }
                : {
                    sub: 'user',
                    aud: 'api',
                    exp: boundary / 1000 + 100,
                    nbf: boundary / 1000 + skew,
                  };
            const token = await signToken(key, payload);
            const outcome = await verifier.verify(token);
            if (claim === 'exp' ? offset >= 0 : offset < 0) {
              expect(outcome).toEqual({
                ok: false,
                reason: claim === 'exp' ? 'expired' : 'not-yet-valid',
              });
            } else {
              expect(outcome).toMatchObject({ ok: true, claims: { sub: 'user' } });
            }
          });
        }
      }
    }
  }
});
