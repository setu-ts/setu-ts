/**
 * Compilation of the `resourceServer` option (M132 §3.4): validation, the
 * RFC 9728 §3.1 metadata path/URL derivation, and the document serialized once.
 *
 * The resource identifier comes from configuration only. Nothing here reads a
 * request's `Host` or `X-Forwarded-*` headers, so a spoofed host cannot make
 * the server publish metadata naming another resource.
 *
 * @module
 */

import type { ResourceServerOptions } from '../interfaces/index.ts';
import { AuthPluginConfigurationError } from '../errors.ts';
import { isAcceptableUrl } from '../issuers/trusted-issuer.ts';
import type { CompiledIssuer } from '../issuers/trusted-issuer.ts';
import { isScopeToken } from './claims.ts';

/** The well-known prefix RFC 9728 §3.1 appends the resource's path to. */
const METADATA_PREFIX = '/.well-known/oauth-protected-resource';

/** A validated `resourceServer` option with every derived value applied. */
export interface CompiledResourceServer {
  /** The configured resource identifier, verbatim. */
  readonly resource: string;
  /** Route path the metadata document is served at. */
  readonly metadataPath: string;
  /** Absolute URL of the metadata document. */
  readonly metadataUrl: string;
  /** The RFC 9728 document, serialized exactly once. */
  readonly body: string;
}

/** Refuses a malformed resource server configuration. */
function refuse(reason: string): never {
  throw new AuthPluginConfigurationError(`auth-plugin: resourceServer ${reason}`);
}

/** Normalizes a configured list, refusing a non-array. */
function arrayOf(value: unknown, name: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    refuse(`${name} must be an array`);
  }
  return value;
}

/** Validates one authorization-server identifier. */
function compileAuthorizationServers(
  value: ResourceServerOptions['authorizationServers'],
  issuers: readonly CompiledIssuer[],
): readonly string[] {
  if (value === undefined) {
    return [...new Set(issuers.map((issuer) => issuer.issuer))];
  }
  const entries = arrayOf(value, 'authorizationServers');
  const servers: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== 'string' || !isAcceptableUrl(entry)) {
      refuse('authorizationServers entries must be https, or http on a loopback host');
    }
    servers.push(entry);
  }
  return servers;
}

/** Validates the advertised scope list. */
function compileScopesSupported(
  value: ResourceServerOptions['scopesSupported'],
): readonly string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  const entries = arrayOf(value, 'scopesSupported');
  const scopes: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== 'string' || !isScopeToken(entry)) {
      refuse('scopesSupported entries must be RFC 6749 scope tokens');
    }
    scopes.push(entry);
  }
  return scopes;
}

/**
 * Validates and compiles the `resourceServer` option.
 *
 * @param options - The configured resource server
 * @param issuers - The compiled issuers, whose `issuer` values default
 *   `authorizationServers`
 * @returns The compiled resource server, including its serialized document
 * @throws {AuthPluginConfigurationError} When the resource, an
 *   authorization-server URL, a scope or the resource name is unacceptable
 */
export function compileResourceServer(
  options: ResourceServerOptions,
  issuers: readonly CompiledIssuer[],
): CompiledResourceServer {
  const resource = options.resource;
  if (typeof resource !== 'string' || !isAcceptableUrl(resource)) {
    refuse('resource must be https, or http on a loopback host');
  }
  const url = new URL(resource);
  if (url.search !== '' || url.hash !== '' || url.username !== '' || url.password !== '') {
    refuse('resource must carry no query, fragment or userinfo');
  }

  const authorizationServers = compileAuthorizationServers(options.authorizationServers, issuers);
  const scopesSupported = compileScopesSupported(options.scopesSupported);
  const resourceName = options.resourceName;
  if (
    resourceName !== undefined &&
    (typeof resourceName !== 'string' || resourceName.length === 0)
  ) {
    refuse('resourceName must be a non-empty string');
  }

  const resourcePath = url.pathname.endsWith('/') ? url.pathname.slice(0, -1) : url.pathname;
  const metadataPath = `${METADATA_PREFIX}${resourcePath}`;
  const metadataUrl = `${url.origin}${metadataPath}`;

  // RFC 9728 §3.2: every absent or empty member is omitted.
  const document: Record<string, unknown> = { resource };
  if (authorizationServers.length > 0) {
    document.authorization_servers = authorizationServers;
  }
  if (scopesSupported !== undefined && scopesSupported.length > 0) {
    document.scopes_supported = scopesSupported;
  }
  if (resourceName !== undefined) {
    document.resource_name = resourceName;
  }
  document.bearer_methods_supported = ['header'];

  return {
    resource,
    metadataPath,
    metadataUrl,
    body: JSON.stringify(document),
  };
}
