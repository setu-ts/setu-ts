/**
 * JwtResolver tests.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { assertSome } from '../fixtures/option.ts';
import { JwtResolver } from '../../src/resolvers/jwt-resolver.ts';
import { createFakeRequest } from '../fixtures/fake-request.ts';

describe('jwt resolver', () => {
  it('JwtResolver — valid token with claim', async () => {
    const fakeDecode = () => ({ tenant_id: 'acme' });
    const resolver = new JwtResolver({ decode: fakeDecode });
    const result = await resolver.resolve(
      createFakeRequest({ headers: { authorization: 'Bearer fake.token.here' } }),
    );
    assertSome(result);
    expect(result.value.id).toEqual('acme');
  });

  it('JwtResolver — missing header returns none', async () => {
    const fakeDecode = () => null;
    const resolver = new JwtResolver({ decode: fakeDecode });
    const result = await resolver.resolve(createFakeRequest());
    expect(!result.present).toBeTruthy();
  });

  it('JwtResolver — decode returns null returns none', async () => {
    const fakeDecode = () => null;
    const resolver = new JwtResolver({ decode: fakeDecode });
    const result = await resolver.resolve(
      createFakeRequest({ headers: { authorization: 'Bearer x.y.z' } }),
    );
    expect(!result.present).toBeTruthy();
  });

  it('JwtResolver — claim absent returns none', async () => {
    const fakeDecode = () => ({ other: 'value' });
    const resolver = new JwtResolver({ decode: fakeDecode });
    const result = await resolver.resolve(
      createFakeRequest({ headers: { authorization: 'Bearer x.y.z' } }),
    );
    expect(!result.present).toBeTruthy();
  });

  it('JwtResolver — custom claim and header name', async () => {
    const fakeDecode = () => ({ org: 'globex' });
    const resolver = new JwtResolver({
      decode: fakeDecode,
      claim: 'org',
      headerName: 'x-auth',
    });
    const result = await resolver.resolve(
      createFakeRequest({ headers: { 'x-auth': 'Bearer token' } }),
    );
    assertSome(result);
    expect(result.value.id).toEqual('globex');
  });

  it('JwtResolver — non-Bearer header uses raw value as token', async () => {
    // Tests the branch where rawHeader does NOT start with "Bearer " or "bearer "
    // (line 49 in jwt-resolver.ts: else { token = rawHeader; }).
    const fakeDecode = (token: string) => {
      expect(token === 'raw-jwt-token').toBeTruthy();
      return { tenant_id: 'raw-tenant' };
    };
    const resolver = new JwtResolver({ decode: fakeDecode });
    const result = await resolver.resolve(
      createFakeRequest({ headers: { authorization: 'raw-jwt-token' } }),
    );
    assertSome(result);
    expect(result.value.id).toEqual('raw-tenant');
  });

  it('JwtResolver — header present but decode returns null returns none', async () => {
    const fakeDecode = () => null;
    const resolver = new JwtResolver({ decode: fakeDecode });
    const result = await resolver.resolve(
      createFakeRequest({ headers: { authorization: 'some-token' } }),
    );
    expect(!result.present).toBeTruthy();
  });
});
