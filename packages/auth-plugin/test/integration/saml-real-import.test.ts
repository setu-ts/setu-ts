/**
 * The REAL lazy import path (M100f plan §3.1): `importSamlModule()` loads
 * `npm:@node-saml/node-saml@^5`, the adapter accepts it, and the loaded class
 * verifies a response from the test IdP — the path `register()` takes when no
 * module is injected.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { adaptSamlModule, importSamlModule, loadSaml } from '../../src/saml/loader.ts';
import { buildLibraryConfig } from '../../src/saml/engine.ts';
import { compileSamlProvider } from '../../src/saml/config.ts';
import {
  ACS_URL,
  generateSigningKey,
  IDP_ENTITY,
  IDP_SSO,
  PROVIDER,
  signedResponse,
  SP_ENTITY,
} from '../fixtures/saml-idp.ts';

describe('SAML real import', () => {
  it('loads node-saml through the literal npm: specifier and verifies a signed response', async () => {
    const SAML = adaptSamlModule(await importSamlModule());
    expect(await loadSaml(undefined)).toBe(SAML);

    const key = await generateSigningKey();
    const provider = compileSamlProvider(
      {
        kind: 'saml',
        name: PROVIDER,
        entityId: SP_ENTITY,
        idp: { entityId: IDP_ENTITY, ssoUrl: IDP_SSO, certs: [key.publicPem] },
        acsUrl: ACS_URL,
        toPrincipal: () => null,
      },
      PROVIDER,
      '/auth',
    );
    const pending = new Map([['_r1', new Date().toISOString()]]);
    const saml = new SAML(buildLibraryConfig(provider, {
      saveAsync: () => Promise.resolve(null),
      getAsync: (id) => Promise.resolve(pending.get(id) ?? null),
      removeAsync: (id) => Promise.resolve(id === null ? null : pending.get(id) ?? null),
    }));
    const result = await saml.validatePostResponseAsync({
      SAMLResponse: signedResponse(key, '_r1'),
    });
    expect(result.profile?.nameID).toBe('alice');
  });
});
