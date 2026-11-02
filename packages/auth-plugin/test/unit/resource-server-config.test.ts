/**
 * Compilation of the `resourceServer` option: refusals, derived metadata
 * path/URL, and the RFC 9728 document.
 *
 * @module
 */

import { describe, expect, it } from 'vitest';
import { AuthPluginConfigurationError } from '../../src/errors.ts';
import { compileResourceServer } from '../../src/resource-server/config.ts';
import { compileIssuers } from '../../src/issuers/trusted-issuer.ts';
import type { CompiledIssuer } from '../../src/issuers/trusted-issuer.ts';
import type { TrustedIssuer } from '../../src/interfaces/index.ts';

/** A compiled issuer whose only relevant member here is its `issuer`. */
function compiledIssuer(issuer: string, name = issuer): CompiledIssuer {
  const [compiled] = compileIssuers([
    {
      name,
      issuer,
      audience: 'api',
      keys: { jwksUri: 'https://idp.test/jwks' },
      toPrincipal: () => null,
    } satisfies TrustedIssuer,
  ]);
  return compiled;
}

function refusal(options: Parameters<typeof compileResourceServer>[0]): string {
  try {
    compileResourceServer(options, []);
  } catch (error) {
    expect(error).toBeInstanceOf(AuthPluginConfigurationError);
    return (error as Error).message;
  }
  throw new Error('expected a refusal');
}

function documentOf(resource: string, extra: Record<string, unknown> = {}): unknown {
  return JSON.parse(compileResourceServer({ resource, ...extra }, []).body);
}

describe('compileResourceServer refusals', () => {
  it('refuses a resource that would weaken or misidentify the deployment', () => {
    const cases: Array<[Parameters<typeof compileResourceServer>[0], string]> = [
      [{ resource: 'http://resource.test' }, 'resource must be https'],
      [{ resource: 'not a url' }, 'resource must be https'],
      [{ resource: 'https://resource.test/mcp?tenant=1' }, 'no query'],
      [{ resource: 'https://resource.test/mcp#fragment' }, 'no query, fragment or userinfo'],
      [{ resource: 'https://user:secret@resource.test/mcp' }, 'userinfo'],
      [{ resource: 'https://resource.test/mcp', resourceName: '' }, 'non-empty string'],
      [
        { resource: 'https://resource.test/mcp', authorizationServers: ['http://as.test'] },
        'authorizationServers entries',
      ],
      [
        {
          resource: 'https://resource.test/mcp',
          authorizationServers: 'https://as.test',
        } as unknown as Parameters<typeof compileResourceServer>[0],
        'authorizationServers must be an array',
      ],
      [{ resource: 'https://resource.test/mcp', scopesSupported: ['read', 'a b'] }, 'scope tokens'],
      [
        {
          resource: 'https://resource.test/mcp',
          scopesSupported: 'read',
        } as unknown as Parameters<typeof compileResourceServer>[0],
        'scopesSupported must be an array',
      ],
    ];
    for (const [options, message] of cases) {
      expect(refusal(options)).toContain(message);
    }
  });

  it('accepts an http loopback resource and a non-URL audience elsewhere', () => {
    const compiled = compileResourceServer({ resource: 'http://localhost:3000/mcp' }, []);
    expect(compiled.resource).toBe('http://localhost:3000/mcp');
    expect(compiled.metadataUrl).toBe(
      'http://localhost:3000/.well-known/oauth-protected-resource/mcp',
    );
  });
});

describe('compileResourceServer path and URL derivation', () => {
  const cases: Array<[string, string, string]> = [
    [
      'https://h',
      '/.well-known/oauth-protected-resource',
      'https://h/.well-known/oauth-protected-resource',
    ],
    [
      'https://h/',
      '/.well-known/oauth-protected-resource',
      'https://h/.well-known/oauth-protected-resource',
    ],
    [
      'https://h/mcp',
      '/.well-known/oauth-protected-resource/mcp',
      'https://h/.well-known/oauth-protected-resource/mcp',
    ],
    [
      'https://h/a/b/',
      '/.well-known/oauth-protected-resource/a/b',
      'https://h/.well-known/oauth-protected-resource/a/b',
    ],
  ];

  it.each(cases)('%s derives its well-known path and URL', (resource, path, url) => {
    const compiled = compileResourceServer({ resource }, []);
    expect(compiled.metadataPath).toBe(path);
    expect(compiled.metadataUrl).toBe(url);
  });
});

describe('compileResourceServer document', () => {
  it('omits every absent or empty member but always advertises the header method', () => {
    expect(documentOf('https://h/mcp')).toEqual({
      resource: 'https://h/mcp',
      bearer_methods_supported: ['header'],
    });
    expect(documentOf('https://h/mcp', { authorizationServers: [], scopesSupported: [] })).toEqual({
      resource: 'https://h/mcp',
      bearer_methods_supported: ['header'],
    });
  });

  it('publishes the configured members verbatim', () => {
    expect(
      documentOf('https://h/mcp', {
        authorizationServers: ['https://as.test', 'https://as2.test'],
        scopesSupported: ['tools:read', 'tools:list'],
        resourceName: 'Tools',
      }),
    ).toEqual({
      resource: 'https://h/mcp',
      authorization_servers: ['https://as.test', 'https://as2.test'],
      scopes_supported: ['tools:read', 'tools:list'],
      resource_name: 'Tools',
      bearer_methods_supported: ['header'],
    });
  });

  it('defaults authorizationServers to the distinct issuer values in order', () => {
    const issuers = [compiledIssuer('https://a.test', 'a'), compiledIssuer('https://b.test', 'b')];
    const parsed = JSON.parse(
      compileResourceServer({ resource: 'https://h/mcp' }, issuers).body,
    ) as { authorization_servers: readonly string[] };
    expect(parsed.authorization_servers).toEqual(['https://a.test', 'https://b.test']);
  });

  it('omits authorization_servers when there are no issuers and none configured', () => {
    expect(documentOf('https://h/mcp')).not.toHaveProperty('authorization_servers');
  });

  it('prefers an explicitly configured list over the issuers default', () => {
    const parsed = JSON.parse(
      compileResourceServer(
        { resource: 'https://h/mcp', authorizationServers: ['https://explicit.test'] },
        [compiledIssuer('https://a.test')],
      ).body,
    ) as { authorization_servers: readonly string[] };
    expect(parsed.authorization_servers).toEqual(['https://explicit.test']);
  });
});
