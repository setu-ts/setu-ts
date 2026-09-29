import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { signToken } from '../fixtures/issuer-tokens.ts';
import { NOW, request, setupStrategy, valid } from '../fixtures/issuer-strategy-setup.ts';

const nowSec = NOW / 1000;

async function outcome(
  payload: Record<string, unknown>,
  clockToleranceSec?: number,
): Promise<string> {
  const t = await setupStrategy(
    clockToleranceSec === undefined ? {} : { issuer: { clockToleranceSec } },
  );
  const principal = await t.strategy.authenticate(
    request(`Bearer ${await signToken(t.key, payload)}`),
  );
  return principal === null ? t.refusals.join(',') : 'ok';
}

describe('issuer claim validation', () => {
  it('accepts aud as a string or an array containing the audience', async () => {
    expect(await outcome(valid({ aud: 'api' }))).toBe('ok');
    expect(await outcome(valid({ aud: ['other', 'api'] }))).toBe('ok');
    expect(await outcome(valid({ aud: 'other' }))).toBe('audience-mismatch');
    expect(await outcome(valid({ aud: undefined }))).toBe('audience-mismatch');
  });

  it('requires a finite exp', async () => {
    expect(await outcome(valid({ exp: undefined }))).toBe('exp-missing');
    expect(await outcome(valid({ exp: '9999999999' }))).toBe('exp-missing');
  });

  it('applies the default 30 s skew to exp on both sides of the boundary', async () => {
    expect(await outcome(valid({ exp: nowSec - 30 }))).toBe('ok');
    expect(await outcome(valid({ exp: nowSec - 31 }))).toBe('expired');
    expect(await outcome(valid({ exp: nowSec - 1 }), 0)).toBe('expired');
  });

  it('checks nbf with skew', async () => {
    expect(await outcome(valid({ nbf: nowSec + 30 }))).toBe('ok');
    expect(await outcome(valid({ nbf: nowSec + 31 }))).toBe('not-yet-valid');
    expect(await outcome(valid({ nbf: 'soon' }))).toBe('not-yet-valid');
  });

  it('refuses an iat in the future beyond the skew', async () => {
    expect(await outcome(valid({ iat: nowSec + 30 }))).toBe('ok');
    expect(await outcome(valid({ iat: nowSec + 31 }))).toBe('issued-in-future');
    expect(await outcome(valid({ iat: 'x' }))).toBe('issued-in-future');
  });
});
