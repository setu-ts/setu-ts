/**
 * The SAML service-provider routes: login, assertion consumer service, and
 * metadata (M100f plan §3.3–§3.6). Internal: registered by `AuthPlugin` when a
 * `saml` sign-in provider is configured.
 *
 * Three routes per provider: `GET <basePath>/<name>/login` issues an
 * AuthnRequest over the HTTP-Redirect binding, `POST <basePath>/<name>/acs`
 * consumes the IdP's response over HTTP-POST, and
 * `GET <basePath>/<name>/metadata` publishes the SP descriptor.
 *
 * Signature, audience, time window and `InResponseTo` are checked by
 * node-saml. Three checks node-saml 5.1.0 does NOT make on an authentication
 * response are made here, by reading the verified assertion: its `Issuer`
 * must equal the configured IdP entity id (the library's `idpIssuer` is read
 * only for logout messages), every `SubjectConfirmationData` must name this
 * provider's ACS URL as its `Recipient`, and the assertion `ID` is claimed once
 * in the store, so a captured response cannot be posted twice.
 * The pending request is bound to the browser that started the login through
 * a `__Host-` cookie, and the ACS reads `provider`, `returnTo` and `binding`
 * only from the record IT consumed.
 *
 * Failures answer with a fixed `401` detail or a fixed `?error=` redirect; the
 * library's own message is reported at `debug` and never returned.
 *
 * @module
 */

import type {
  IAuthSessionService,
  IRequestContext,
  IRouterApi,
  IRuntimeServices,
} from '@setu-ts/common';
import { parseFormBody, respondWithError } from '@setu-ts/common';
import type { SamlProfile } from '../interfaces/index.ts';
import type { SamlPendingRequest } from '../stores/saml-request-store.ts';
import { encodeBase64Url } from '../utils/base64url.ts';
import {
  PRINCIPAL_REFUSED_DETAIL,
  PROVIDER_UNAVAILABLE_DETAIL,
  REDIRECT_STATE_KEY,
  RETURN_TO_QUERY_PARAM,
} from '../sign-in/routes.ts';
import { safeReturnTo } from '../sign-in/return-to.ts';
import type { CompiledSamlProvider } from './config.ts';
import type {
  SamlCacheProvider,
  SamlConstructor,
  SamlInstance,
  SamlLibraryProfile,
} from './engine.ts';
import { buildLibraryConfig, SAML_CLOCK_SKEW_MS, SAML_PENDING_TTL_MS } from './engine.ts';
import {
  bindingMatches,
  clearBindingCookie,
  readBindingCookie,
  setBindingCookie,
} from './binding-cookie.ts';

/** Binding-cookie entropy in bytes. */
const BINDING_BYTES = 32;

/** The SAML metadata media type (SAML 2.0 Metadata §4.1.1). */
export const SAML_METADATA_CONTENT_TYPE = 'application/samlmetadata+xml';

/**
 * The fixed `?error=` codes (or `401` details) an ACS failure answers with.
 *
 * - `assertion-invalid` — the response did not verify: signature, issuer,
 *   audience, recipient, time window, an encrypted or unsigned assertion, or a
 *   replayed assertion id.
 * - `state-invalid` — the response does not belong to a login this browser
 *   started: no pending request, another provider's request, or a missing or
 *   mismatched binding cookie.
 */
export type SamlErrorCode = 'assertion-invalid' | 'state-invalid';

/** A provider with its loaded library constructor. */
export interface LoadedSamlProvider {
  readonly provider: CompiledSamlProvider;
  readonly SAML: SamlConstructor;
}

/** Deps for {@linkcode registerSamlRoutes}. */
export interface SamlRouteDeps {
  readonly router: IRouterApi;
  readonly providers: readonly LoadedSamlProvider[];
  readonly authSessionService: IAuthSessionService;
  readonly runtime: IRuntimeServices;
  /** Where a sign-in held for a second factor goes; else its `returnTo`. */
  readonly challengePath?: string;
  /** Best-effort debug reporting. */
  readonly debug?: (message: string) => void;
}

/** A flow's result: the redirect target, or `null` when a refusal was written. */
type FlowOutcome = string | null;

/** A route whose flow runs as middleware and whose terminal handler redirects. */
function flowRoute(flow: (ctx: IRequestContext) => Promise<FlowOutcome>) {
  return {
    middleware: [async (ctx: IRequestContext, next: () => Promise<void>) => {
      const target = await flow(ctx);
      if (target === null) {
        return;
      }
      ctx.state.set(REDIRECT_STATE_KEY, target);
      await next();
    }],
    handler: (ctx: IRequestContext) =>
      ctx.response.redirect(String(ctx.state.get(REDIRECT_STATE_KEY)), 302),
  };
}

/** Answers an ACS failure: a fixed redirect, or a `401` with the code as detail. */
function fail(
  provider: CompiledSamlProvider,
  ctx: IRequestContext,
  code: SamlErrorCode,
): FlowOutcome {
  const target = provider.failureRedirect;
  if (target === undefined) {
    respondWithError(ctx, { status: 401, title: 'Unauthorized', detail: code });
    return null;
  }
  const separator = target.includes('?') ? '&' : '?';
  return `${target}${separator}error=${code}`;
}

/** Reads a value only if it is a non-empty string. */
function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Reads `node.$[name]` from an xml2js node. */
function attributeOf(node: unknown, name: string): unknown {
  if (typeof node !== 'object' || node === null) {
    return undefined;
  }
  const attrs = (node as Record<string, unknown>).$;
  return typeof attrs === 'object' && attrs !== null
    ? (attrs as Record<string, unknown>)[name]
    : undefined;
}

/** Reads `node[name]` as an array of child nodes. */
function childrenOf(node: unknown, name: string): readonly unknown[] {
  if (typeof node !== 'object' || node === null) {
    return [];
  }
  const value = (node as Record<string, unknown>)[name];
  return Array.isArray(value) ? value : [];
}

/** Reads an xml2js element's text: a bare string, or its `_` character key. */
function textOf(node: unknown): string | undefined {
  if (typeof node === 'string') {
    return stringOf(node);
  }
  return typeof node === 'object' && node !== null
    ? stringOf((node as Record<string, unknown>)._)
    : undefined;
}

/** What the plugin reads from the verified assertion itself. */
interface AssertionFacts {
  readonly id: string;
  readonly recipients: readonly unknown[];
  /** The assertion's `Issuer` element text, or `undefined` when absent. */
  readonly issuer: string | undefined;
  /** The `Subject`'s `NameID` element text, or `undefined` when absent. */
  readonly nameID: string | undefined;
  /** The `NameID` `Format`, when present. */
  readonly nameIDFormat: string | undefined;
  /** The first `AuthnStatement` `SessionIndex`, when present. */
  readonly sessionIndex: string | undefined;
  /** Every `SubjectConfirmationData` `InResponseTo`, inside the signature. */
  readonly inResponseTos: readonly unknown[];
  /** The latest `NotOnOrAfter` found, in ms, or `null` when none parsed. */
  readonly expiresAt: number | null;
}

/**
 * Extracts the assertion `ID`, every `SubjectConfirmationData` `Recipient`, and
 * the latest `NotOnOrAfter`, from the VERIFIED assertion the library returned
 * (`getAssertion()` parses the signed XML, not the unsigned envelope).
 */
function assertionFacts(profile: SamlLibraryProfile): AssertionFacts | null {
  const parsed = typeof profile.getAssertion === 'function' ? profile.getAssertion() : undefined;
  const assertion = typeof parsed === 'object' && parsed !== null
    ? (parsed as Record<string, unknown>).Assertion
    : undefined;
  const id = stringOf(attributeOf(assertion, 'ID'));
  if (id === undefined) {
    return null;
  }
  const recipients: unknown[] = [];
  const inResponseTos: unknown[] = [];
  const deadlines: unknown[] = [];
  for (const subject of childrenOf(assertion, 'Subject')) {
    for (const confirmation of childrenOf(subject, 'SubjectConfirmation')) {
      const data = childrenOf(confirmation, 'SubjectConfirmationData');
      if (data.length === 0) {
        // A confirmation without data carries no Recipient: it cannot be bound
        // to this ACS, so it counts as a mismatch rather than being skipped.
        recipients.push(undefined);
        inResponseTos.push(undefined);
      }
      for (const entry of data) {
        recipients.push(attributeOf(entry, 'Recipient'));
        inResponseTos.push(attributeOf(entry, 'InResponseTo'));
        deadlines.push(attributeOf(entry, 'NotOnOrAfter'));
      }
    }
  }
  for (const conditions of childrenOf(assertion, 'Conditions')) {
    deadlines.push(attributeOf(conditions, 'NotOnOrAfter'));
  }
  let expiresAt: number | null = null;
  for (const deadline of deadlines) {
    const ms = typeof deadline === 'string' ? Date.parse(deadline) : Number.NaN;
    if (Number.isFinite(ms) && (expiresAt === null || ms > expiresAt)) {
      expiresAt = ms;
    }
  }
  const subject = childrenOf(assertion, 'Subject')[0];
  const nameIdNode = childrenOf(subject, 'NameID')[0];
  return {
    id,
    // Read from the elements, never from node-saml's merged `profile`: it
    // copies every attribute onto the profile, so an assertion with no
    // `Issuer` or `NameID` element but an attribute of that name would
    // otherwise supply both.
    issuer: textOf(childrenOf(assertion, 'Issuer')[0]),
    nameID: textOf(nameIdNode),
    nameIDFormat: stringOf(attributeOf(nameIdNode, 'Format')),
    sessionIndex: stringOf(attributeOf(childrenOf(assertion, 'AuthnStatement')[0], 'SessionIndex')),
    recipients,
    inResponseTos,
    expiresAt,
  };
}

/**
 * Builds the frozen profile `toPrincipal` receives from the signed assertion's
 * own elements, or `null` when it carries no `Issuer` or no `NameID`.
 */
function toSamlProfile(facts: AssertionFacts, profile: SamlLibraryProfile): SamlProfile | null {
  if (facts.issuer === undefined || facts.nameID === undefined) {
    return null;
  }
  const attributes = typeof profile.attributes === 'object' && profile.attributes !== null
    ? { ...(profile.attributes as Record<string, unknown>) }
    : {};
  return Object.freeze({
    issuer: facts.issuer,
    nameID: facts.nameID,
    ...(facts.nameIDFormat === undefined ? {} : { nameIDFormat: facts.nameIDFormat }),
    ...(facts.sessionIndex === undefined ? {} : { sessionIndex: facts.sessionIndex }),
    attributes: Object.freeze(attributes),
  });
}

/** A cache-provider method answering nothing. */
const nothing = (): Promise<null> => Promise.resolve(null);

/** A cache provider that answers nothing; for metadata, which reads no request. */
const INERT_CACHE: SamlCacheProvider = {
  saveAsync: nothing,
  getAsync: nothing,
  removeAsync: nothing,
};

function registerLogin(loaded: LoadedSamlProvider, deps: SamlRouteDeps): void {
  const { provider, SAML } = loaded;
  deps.router.get(
    provider.loginPath,
    flowRoute(async (ctx) => {
      const binding = encodeBase64Url(deps.runtime.randomBytes(BINDING_BYTES));
      const returnTo = safeReturnTo(ctx.query[RETURN_TO_QUERY_PARAM]);
      let saved = false;
      // node-saml generates the request id and hands it to `saveAsync`; this
      // adapter turns that into the pending record, with the binding and
      // `returnTo` beside it, in the provider's store.
      const cache: SamlCacheProvider = {
        saveAsync: async (requestId, issuedAt) => {
          const now = deps.runtime.now();
          const request: SamlPendingRequest = {
            requestId,
            provider: provider.name,
            returnTo,
            binding,
            issuedAt,
            expiresAt: now + SAML_PENDING_TTL_MS,
          };
          await provider.store.saveRequest(request, now);
          saved = true;
          return { value: issuedAt, createdAt: now };
        },
        getAsync: nothing,
        removeAsync: nothing,
      };
      let url: string;
      try {
        const saml = new SAML(buildLibraryConfig(provider, cache));
        url = await saml.getAuthorizeUrlAsync('', undefined, {});
      } catch (error) {
        deps.debug?.(
          `auth-plugin: signIn['${provider.name}'] AuthnRequest failed (${describeError(error)})`,
        );
        url = '';
      }
      if (!saved || url === '') {
        // Never redirect for a request no store holds: its response could only
        // ever be refused.
        respondWithError(ctx, {
          status: 503,
          title: 'Service Unavailable',
          detail: PROVIDER_UNAVAILABLE_DETAIL,
        });
        return null;
      }
      setBindingCookie(ctx, binding);
      return url;
    }),
  );
}

/** Reads the `SAMLResponse` form field, or `null`. */
async function readSamlResponse(ctx: IRequestContext): Promise<string | null> {
  try {
    const form = ctx.request.formData !== undefined
      ? await ctx.request.formData()
      : parseFormBody(await ctx.request.bytes(), ctx.request.headers.get('content-type'));
    const value = form.get('SAMLResponse');
    return typeof value === 'string' && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/** A short, non-quoting description of a thrown value for the debug log. */
export function describeError(error: unknown): string {
  // The library's messages can quote attacker-supplied values (an audience, an
  // issuer), so control characters are removed and the length capped before
  // the text reaches a log line.
  const text = error instanceof Error ? error.message : 'non-error thrown';
  // deno-lint-ignore no-control-regex
  return text.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 200);
}

function registerAcs(loaded: LoadedSamlProvider, deps: SamlRouteDeps): void {
  const { provider, SAML } = loaded;
  deps.router.post(
    provider.acsPath,
    flowRoute(async (ctx) => {
      const presented = readBindingCookie(ctx);
      // The binding is single use, like its request — so it is cleared exactly
      // when a pending request is consumed (inside `consume` below), never
      // before. Clearing it on every outcome let a cross-site POST of an empty
      // or junk body to this CSRF-exempt route, carrying the victim's
      // `SameSite=None` cookie, burn the victim's in-flight login (M101c audit).
      const encoded = await readSamlResponse(ctx);
      if (encoded === null) {
        return fail(provider, ctx, 'assertion-invalid');
      }

      // The one record this request consumed. Of two concurrent posts of one
      // response, both may pass the library's `getAsync`, but only one
      // `consumeRequest` returns the record, so only one proceeds.
      let captured: SamlPendingRequest | null = null;
      let consumed = false;
      const consume = async (requestId: string): Promise<SamlPendingRequest | null> => {
        if (!consumed) {
          consumed = true;
          captured = await provider.store.consumeRequest(requestId, deps.runtime.now());
          if (captured !== null) {
            clearBindingCookie(ctx);
          }
        }
        return captured;
      };

      // V8-25 (M101c): the binding is checked BEFORE the request is consumed.
      // `getAsync` peeks the record and, when the presented binding cookie is
      // absent or does not match the record's `binding`, sets `bindingRefused`
      // and returns `null` WITHOUT consuming. The library then throws, and
      // `removeAsync` — which node-saml 5.1.0 calls on its failure path
      // (`lib/saml.js:628` catch, `:803`/`:814` before throwing on an
      // unmatched `InResponseTo`) — returns `null` without consuming while the
      // flag is set. This is load-bearing: without it, a foreign browser's
      // post of a SAML response burns the victim's pending login, because the
      // library's failure-path `removeAsync` consumes the record.
      let bindingRefused = false;

      const cache: SamlCacheProvider = {
        saveAsync: nothing,
        getAsync: async (requestId) => {
          const record = await provider.store.peekRequest(requestId, deps.runtime.now());
          if (record === null) return null;
          if (presented === null || !bindingMatches(presented, record.binding)) {
            bindingRefused = true;
            return null;
          }
          return record.issuedAt;
        },
        removeAsync: async (requestId) => {
          if (bindingRefused) return null;
          return requestId === null ? null : (await consume(requestId))?.issuedAt ?? null;
        },
      };

      let profile: SamlLibraryProfile | null;
      try {
        const saml: SamlInstance = new SAML(buildLibraryConfig(provider, cache));
        profile = (await saml.validatePostResponseAsync({ SAMLResponse: encoded })).profile;
      } catch (error) {
        // The library has already consumed the request on its failure path, so a
        // response that fails validation cannot be retried against its request —
        // UNLESS the binding was refused: in that case `getAsync` returned
        // `null` without consuming and `removeAsync` was guarded by the flag,
        // so the victim's pending request is still intact.
        if (bindingRefused) {
          deps.debug?.(
            `auth-plugin: signIn['${provider.name}'] response refused (binding, pre-consume)`,
          );
          return fail(provider, ctx, 'state-invalid');
        }
        deps.debug?.(
          `auth-plugin: signIn['${provider.name}'] response refused (${describeError(error)})`,
        );
        return fail(provider, ctx, 'assertion-invalid');
      }
      const inResponseTo = profile === null ? undefined : stringOf(profile.inResponseTo);
      if (profile === null || inResponseTo === undefined) {
        // `null` is a NoPassive or logout answer, neither of which signs anyone in.
        return fail(provider, ctx, 'assertion-invalid');
      }
      // node-saml does not call `removeAsync` on every success path (5.1.0,
      // `lib/saml.js` processValidlySignedAssertionAsync), so consumption is
      // completed here when the library did not perform it.
      const request = await consume(inResponseTo);
      if (request === null) {
        deps.debug?.(`auth-plugin: signIn['${provider.name}'] response refused (request consumed)`);
        return fail(provider, ctx, 'state-invalid');
      }
      if (request.provider !== provider.name) {
        deps.debug?.(`auth-plugin: signIn['${provider.name}'] response refused (wrong provider)`);
        return fail(provider, ctx, 'state-invalid');
      }
      if (presented === null || !bindingMatches(presented, request.binding)) {
        // Login CSRF: a valid response posted by a browser that did not start
        // this login.
        deps.debug?.(`auth-plugin: signIn['${provider.name}'] response refused (binding)`);
        return fail(provider, ctx, 'state-invalid');
      }

      const facts = assertionFacts(profile);
      // node-saml 5.1.0 checks `idpIssuer` only on logout messages, never on an
      // authentication assertion (`lib/saml.js` verifyIssuer), so the signed
      // assertion's own Issuer ELEMENT is bound to the configured IdP here.
      if (facts !== null && facts.issuer !== provider.idp.entityId) {
        deps.debug?.(`auth-plugin: signIn['${provider.name}'] response refused (issuer)`);
        return fail(provider, ctx, 'assertion-invalid');
      }
      if (
        facts === null || facts.recipients.length === 0 ||
        facts.recipients.some((recipient) => recipient !== provider.acsUrl)
      ) {
        deps.debug?.(`auth-plugin: signIn['${provider.name}'] response refused (recipient)`);
        return fail(provider, ctx, 'assertion-invalid');
      }
      // The response envelope is unsigned when only the assertion is signed, so
      // its InResponseTo alone cannot bind a signed assertion to this login: a
      // captured assertion with no InResponseTo of its own could be re-wrapped
      // in a fresh response for the attacker's own pending request. node-saml
      // compares the two only when both are present, so the binding is
      // required here, inside the signature, on every confirmation.
      if (facts.inResponseTos.some((value) => value !== request.requestId)) {
        deps.debug?.(
          `auth-plugin: signIn['${provider.name}'] response refused (unbound assertion)`,
        );
        return fail(provider, ctx, 'assertion-invalid');
      }
      const now = deps.runtime.now();
      // Held until the assertion can no longer be accepted anyway; the skew is
      // added because the library accepts that long past NotOnOrAfter.
      const retainUntil = Math.max(
        (facts.expiresAt ?? now + SAML_PENDING_TTL_MS) + SAML_CLOCK_SKEW_MS,
        now + 1,
      );
      if (!(await provider.store.claimAssertionId(facts.id, retainUntil, now))) {
        deps.debug?.(`auth-plugin: signIn['${provider.name}'] response refused (assertion replay)`);
        return fail(provider, ctx, 'assertion-invalid');
      }

      const samlProfile = toSamlProfile(facts, profile);
      if (samlProfile === null) {
        return fail(provider, ctx, 'assertion-invalid');
      }
      let principal;
      try {
        principal = await provider.toPrincipal(samlProfile);
      } catch {
        principal = null;
      }
      if (principal === null) {
        respondWithError(ctx, {
          status: 403,
          title: 'Forbidden',
          detail: PRINCIPAL_REFUSED_DETAIL,
        });
        return null;
      }
      const outcome = await deps.authSessionService.signIn(ctx, principal, { methods: ['fed'] });
      if (outcome.status === 'second-factor-required') {
        return deps.challengePath ?? request.returnTo;
      }
      return request.returnTo;
    }),
  );
}

function registerMetadata(loaded: LoadedSamlProvider, deps: SamlRouteDeps): void {
  const { provider, SAML } = loaded;
  // Built once: the descriptor depends only on configuration.
  let document: Uint8Array | null = null;
  deps.router.get(provider.metadataPath, (ctx) => {
    if (document === null) {
      const saml = new SAML(buildLibraryConfig(provider, INERT_CACHE));
      document = new TextEncoder().encode(saml.generateServiceProviderMetadata(null));
    }
    return ctx.response.header('Content-Type', SAML_METADATA_CONTENT_TYPE).send(document);
  });
}

/**
 * Registers the three routes of every `saml` provider.
 *
 * @param deps - The router, the loaded providers and the services they need
 */
export function registerSamlRoutes(deps: SamlRouteDeps): void {
  for (const loaded of deps.providers) {
    registerLogin(loaded, deps);
    registerAcs(loaded, deps);
    registerMetadata(loaded, deps);
  }
}
