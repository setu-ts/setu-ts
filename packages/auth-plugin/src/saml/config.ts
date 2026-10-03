/**
 * Validation of the `saml` sign-in arm (M100f plan §3.2). Internal: called by
 * `compileSignIn`, so every refusal happens when `AuthPlugin(...)` is called.
 *
 * @module
 */

import { AuthPluginConfigurationError } from '../errors.ts';
import { isAcceptableUrl } from '../issuers/trusted-issuer.ts';
import type { SamlModule, SamlProfile, SamlProvider } from '../interfaces/index.ts';
import type { ISamlRequestStore } from '../stores/saml-request-store.ts';
import { MemorySamlRequestStore } from '../stores/saml-request-store.ts';
import { safeReturnTo } from '../sign-in/return-to.ts';
import type { IPrincipal } from '@setu-ts/common';

/** A validated `saml` provider with defaults applied and its route paths. */
export interface CompiledSamlProvider {
  readonly kind: 'saml';
  readonly name: string;
  readonly entityId: string;
  readonly idp: {
    readonly entityId: string;
    readonly ssoUrl: string;
    readonly certs: readonly string[];
  };
  readonly acsUrl: string;
  /** `<basePath>/<name>/login`. */
  readonly loginPath: string;
  /** `<basePath>/<name>/acs`. */
  readonly acsPath: string;
  /** `<basePath>/<name>/metadata`. */
  readonly metadataPath: string;
  readonly toPrincipal: (profile: SamlProfile) => IPrincipal | null | Promise<IPrincipal | null>;
  readonly failureRedirect?: string;
  readonly store: ISamlRequestStore;
  readonly module?: SamlModule;
}

const STORE_METHODS = ['saveRequest', 'peekRequest', 'consumeRequest', 'claimAssertionId'] as const;

function refuse(name: string, reason: string): never {
  throw new AuthPluginConfigurationError(`auth-plugin: signIn['${name}'] ${reason}`);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Validates one `saml` provider.
 *
 * @param provider - The configured arm
 * @param name - Its already-validated kebab-case name
 * @param basePath - The sign-in base path (`''` for root)
 * @returns The compiled provider
 * @throws {AuthPluginConfigurationError} On any malformed field
 */
export function compileSamlProvider(
  provider: SamlProvider,
  name: string,
  basePath: string,
): CompiledSamlProvider {
  if (!isNonEmptyString(provider.entityId)) {
    refuse(name, 'needs a non-empty entityId');
  }
  const idp = provider.idp;
  if (typeof idp !== 'object' || idp === null) {
    refuse(name, 'needs an idp object');
  }
  if (!isNonEmptyString(idp.entityId)) {
    refuse(name, 'idp.entityId must be a non-empty string');
  }
  if (!isNonEmptyString(idp.ssoUrl) || !isAcceptableUrl(idp.ssoUrl)) {
    refuse(name, 'idp.ssoUrl must be https, or http on a loopback host');
  }
  // An empty certificate list verifies nothing — node-saml would refuse every
  // response, but only at the first login, with a message naming no option.
  if (
    !Array.isArray(idp.certs) || idp.certs.length === 0 ||
    idp.certs.some((cert) => !isNonEmptyString(cert))
  ) {
    refuse(name, 'idp.certs must be a non-empty array of PEM certificates');
  }
  if (typeof provider.toPrincipal !== 'function') {
    refuse(name, 'needs a toPrincipal function');
  }
  if (!isNonEmptyString(provider.acsUrl) || !isAcceptableUrl(provider.acsUrl)) {
    refuse(name, 'acsUrl must be https, or http on a loopback host');
  }
  const acsPath = `${basePath}/${name}/acs`;
  // The route and the URL the IdP posts to (and the assertion's Recipient)
  // must be the same path, or every login fails at the recipient check.
  if (!new URL(provider.acsUrl).pathname.endsWith(acsPath)) {
    refuse(name, `acsUrl path must end with ${acsPath}`);
  }
  if (
    provider.failureRedirect !== undefined &&
    (provider.failureRedirect === '' ||
      safeReturnTo(provider.failureRedirect, '') !== provider.failureRedirect)
  ) {
    refuse(name, 'failureRedirect must be a same-origin absolute path');
  }
  const store = provider.store;
  if (store !== undefined) {
    const record = store as unknown as Record<string, unknown>;
    if (STORE_METHODS.some((method) => typeof record[method] !== 'function')) {
      refuse(name, `store must implement ${STORE_METHODS.join(', ')}`);
    }
  }
  if (
    provider.module !== undefined &&
    (typeof provider.module !== 'object' || provider.module === null)
  ) {
    refuse(name, 'module must be the SAML library module object');
  }
  return {
    kind: 'saml',
    name,
    entityId: provider.entityId,
    idp: { entityId: idp.entityId, ssoUrl: idp.ssoUrl, certs: [...idp.certs] },
    acsUrl: provider.acsUrl,
    loginPath: `${basePath}/${name}/login`,
    acsPath,
    metadataPath: `${basePath}/${name}/metadata`,
    toPrincipal: provider.toPrincipal,
    ...(provider.failureRedirect === undefined
      ? {}
      : { failureRedirect: provider.failureRedirect }),
    store: store ?? new MemorySamlRequestStore(),
    ...(provider.module === undefined ? {} : { module: provider.module }),
  };
}
