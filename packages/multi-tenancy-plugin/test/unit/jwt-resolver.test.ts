/**
 * JwtResolver tests.
 */
import { assert, assertEquals } from 'jsr:@std/assert@^1.0.19';
import { JwtResolver } from '../../src/resolvers/jwt-resolver.ts';
import { createFakeRequest } from '../fixtures/fake-request.ts';

Deno.test('JwtResolver — valid token with claim', async () => {
  const fakeDecode = () => ({ tenant_id: 'acme' });
  const resolver = new JwtResolver({ decode: fakeDecode });
  const result = await resolver.resolve(
    createFakeRequest({ headers: { authorization: 'Bearer fake.token.here' } }),
  );
  assert(result.present);
  assertEquals(result.value.id, 'acme');
});

Deno.test('JwtResolver — missing header returns none', async () => {
  const fakeDecode = () => null;
  const resolver = new JwtResolver({ decode: fakeDecode });
  const result = await resolver.resolve(createFakeRequest());
  assert(!result.present);
});

Deno.test('JwtResolver — decode returns null returns none', async () => {
  const fakeDecode = () => null;
  const resolver = new JwtResolver({ decode: fakeDecode });
  const result = await resolver.resolve(
    createFakeRequest({ headers: { authorization: 'Bearer x.y.z' } }),
  );
  assert(!result.present);
});

Deno.test('JwtResolver — claim absent returns none', async () => {
  const fakeDecode = () => ({ other: 'value' });
  const resolver = new JwtResolver({ decode: fakeDecode });
  const result = await resolver.resolve(
    createFakeRequest({ headers: { authorization: 'Bearer x.y.z' } }),
  );
  assert(!result.present);
});

Deno.test('JwtResolver — custom claim and header name', async () => {
  const fakeDecode = () => ({ org: 'globex' });
  const resolver = new JwtResolver({
    decode: fakeDecode,
    claim: 'org',
    headerName: 'x-auth',
  });
  const result = await resolver.resolve(
    createFakeRequest({ headers: { 'x-auth': 'Bearer token' } }),
  );
  assert(result.present);
  assertEquals(result.value.id, 'globex');
});
