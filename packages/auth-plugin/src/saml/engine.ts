/**
 * The narrow structural view of node-saml this plugin drives, and the
 * configuration it hands it (M100f plan §3.2). Internal.
 *
 * Every security-relevant option is set EXPLICITLY rather than inherited,
 * because two node-saml 5.1.0 defaults would otherwise decide behaviour:
 * `validateInResponseTo` defaults to `'never'` (accepting unsolicited
 * responses) and `wantAuthnResponseSigned` defaults to `true` (refusing every
 * IdP that signs only the assertion — Entra ID's default). The assertion
 * signature is what authenticates the user, so the assertion is required to
 * be signed and the response signature is optional.
 *
 * @module
 */

/** node-saml's request-id cache contract (`lib/types.d.ts`, `CacheProvider`). */
export interface SamlCacheProvider {
  saveAsync(key: string, value: string): Promise<{ value: string; createdAt: number } | null>;
  getAsync(key: string): Promise<string | null>;
  removeAsync(key: string | null): Promise<string | null>;
}

/** The subset of node-saml's `Profile` this plugin reads. */
export interface SamlLibraryProfile {
  readonly issuer?: unknown;
  readonly nameID?: unknown;
  readonly nameIDFormat?: unknown;
  readonly sessionIndex?: unknown;
  readonly inResponseTo?: unknown;
  readonly attributes?: unknown;
  readonly getAssertion?: () => unknown;
}

/** The subset of a node-saml `SAML` instance this plugin calls. */
export interface SamlInstance {
  getAuthorizeUrlAsync(
    relayState: string,
    host: string | undefined,
    options: Record<string, never>,
  ): Promise<string>;
  validatePostResponseAsync(
    container: Record<string, string>,
  ): Promise<{ profile: SamlLibraryProfile | null; loggedOut: boolean }>;
  generateServiceProviderMetadata(decryptionCert: string | null): string;
}

/** node-saml's `SAML` class. */
export type SamlConstructor = new (config: SamlLibraryConfig) => SamlInstance;

/** The configuration handed to the library, every security field explicit. */
export interface SamlLibraryConfig {
  readonly issuer: string;
  readonly callbackUrl: string;
  readonly entryPoint: string;
  readonly audience: string;
  readonly idpIssuer: string;
  readonly idpCert: string[];
  readonly wantAssertionsSigned: true;
  readonly wantAuthnResponseSigned: false;
  readonly validateInResponseTo: 'always';
  readonly acceptedClockSkewMs: number;
  readonly requestIdExpirationPeriodMs: number;
  readonly maxAssertionAgeMs: number;
  readonly signatureAlgorithm: 'sha256';
  readonly authnRequestBinding: 'HTTP-Redirect';
  readonly identifierFormat: null;
  readonly disableRequestedAuthnContext: true;
  readonly cacheProvider: SamlCacheProvider;
}

/** Clock skew tolerated on `NotBefore`/`NotOnOrAfter`. */
export const SAML_CLOCK_SKEW_MS = 60_000;

/** How long a pending login is honoured, and the binding cookie's lifetime. */
export const SAML_PENDING_TTL_MS = 600_000;

/** What {@linkcode buildLibraryConfig} needs from a compiled provider. */
export interface LibraryConfigInput {
  readonly entityId: string;
  readonly acsUrl: string;
  readonly idp: {
    readonly entityId: string;
    readonly ssoUrl: string;
    readonly certs: readonly string[];
  };
}

/**
 * Builds the library configuration for one provider.
 *
 * @param provider - The compiled provider
 * @param cacheProvider - The per-request adapter over the provider's store
 * @returns The configuration, with every security option set
 */
export function buildLibraryConfig(
  provider: LibraryConfigInput,
  cacheProvider: SamlCacheProvider,
): SamlLibraryConfig {
  return {
    issuer: provider.entityId,
    callbackUrl: provider.acsUrl,
    entryPoint: provider.idp.ssoUrl,
    audience: provider.entityId,
    idpIssuer: provider.idp.entityId,
    idpCert: [...provider.idp.certs],
    wantAssertionsSigned: true,
    wantAuthnResponseSigned: false,
    validateInResponseTo: 'always',
    acceptedClockSkewMs: SAML_CLOCK_SKEW_MS,
    // The library re-checks a request's age against this; aligned with the
    // store's own expiry so neither outlives the other.
    requestIdExpirationPeriodMs: SAML_PENDING_TTL_MS,
    // `0` is the library's "no extra limit" — NotOnOrAfter still applies.
    maxAssertionAgeMs: 0,
    signatureAlgorithm: 'sha256',
    authnRequestBinding: 'HTTP-Redirect',
    // No NameIDPolicy Format: the IdP chooses, and the application's
    // `toPrincipal` decides what to do with it.
    identifierFormat: null,
    // No RequestedAuthnContext: requiring one IdPs do not honour (password
    // over TLS) refuses every MFA-backed login at the IdP.
    disableRequestedAuthnContext: true,
    cacheProvider,
  };
}
