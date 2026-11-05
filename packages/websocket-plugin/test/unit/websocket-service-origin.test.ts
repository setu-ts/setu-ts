/**
 * The handshake `Origin` check: a browser attaches the user's cookies to a
 * cross-site WebSocket handshake, so a page on another site must be refused
 * before any guard, context or connection slot is touched.
 */
import { describe, expect, it } from 'vitest';
import type { WebSocketPluginOptions } from '../../src/interfaces/index.ts';
import { resolveOptions, WebSocketService } from '../../src/services/websocket-service.ts';
import { createFakeLogger, createFakeRuntime, upgradeRequest } from '../fixtures/fake-runtime.ts';

const URL_ORIGIN = 'http://localhost';
const PUBLIC_ORIGIN = 'https://public.example';
const LISTED = 'https://app.example.com';

function build(options?: WebSocketPluginOptions, logger = createFakeLogger()) {
  const service = new WebSocketService(createFakeRuntime(), resolveOptions(options), true, logger);
  let guardRuns = 0;
  service.route(
    '/ws',
    {},
    {
      guards: [
        () => {
          guardRuns++;
          return true;
        },
      ],
    },
  );
  return { service, logger, guardRuns: () => guardRuns };
}

/** `[case, Origin header or null, publicOrigin argument, expected decision]`. */
const CASES: ReadonlyArray<readonly [string, string | null, string | undefined, 'accept' | 403]> = [
  ['no Origin header (non-browser client)', null, PUBLIC_ORIGIN, 'accept'],
  ['the public origin the kernel passed', PUBLIC_ORIGIN, PUBLIC_ORIGIN, 'accept'],
  ['the request URL origin when none was passed', URL_ORIGIN, undefined, 'accept'],
  ['a listed origin', LISTED, PUBLIC_ORIGIN, 'accept'],
  [
    'an allowed origin sent with surrounding whitespace (Headers trims it)',
    ` ${PUBLIC_ORIGIN} `,
    PUBLIC_ORIGIN,
    'accept',
  ],
  ['another site', 'https://evil.example', PUBLIC_ORIGIN, 403],
  ['the URL origin when the kernel passed a different public one', URL_ORIGIN, PUBLIC_ORIGIN, 403],
  ['an opaque origin', 'null', PUBLIC_ORIGIN, 403],
  ['a differing scheme', 'http://public.example', PUBLIC_ORIGIN, 403],
  ['a differing port', 'https://public.example:8443', PUBLIC_ORIGIN, 403],
  ['a trailing slash', `${PUBLIC_ORIGIN}/`, PUBLIC_ORIGIN, 403],
  ['a listed origin spelled with a path', `${LISTED}/x`, PUBLIC_ORIGIN, 403],
];

describe('WebSocket handshake Origin check', () => {
  for (const [label, origin, publicOrigin, expected] of CASES) {
    it(`${expected === 'accept' ? 'admits' : 'refuses'} ${label}`, async () => {
      const { service, guardRuns } = build({ allowedOrigins: [LISTED], maxConnections: 1 });
      const headers: Record<string, string> = origin === null ? {} : { origin };
      const decision = await service.routeUpgrade(
        upgradeRequest(`${URL_ORIGIN}/ws`, headers),
        undefined,
        publicOrigin,
      );
      if (expected === 'accept') {
        expect(decision?.accept).toBe(true);
        expect(guardRuns()).toBe(1);
      } else {
        expect(decision).toEqual({ accept: false, status: 403 });
        // Refused before any guard ran or any connection slot was claimed.
        expect(guardRuns()).toBe(0);
        const next = await service.routeUpgrade(
          upgradeRequest(`${URL_ORIGIN}/ws`, { origin: PUBLIC_ORIGIN }),
          undefined,
          PUBLIC_ORIGIN,
        );
        expect(next?.accept).toBe(true);
      }
    });
  }

  it('admits any origin when checkOrigin is false', async () => {
    const { service } = build({ checkOrigin: false });
    const decision = await service.routeUpgrade(
      upgradeRequest(`${URL_ORIGIN}/ws`, { origin: 'https://evil.example' }),
      undefined,
      PUBLIC_ORIGIN,
    );
    expect(decision?.accept).toBe(true);
  });

  it('applies the check through the adapter-facing router too', async () => {
    const { service } = build();
    const router = service.createUpgradeRouter();
    expect(
      await router(upgradeRequest(`${URL_ORIGIN}/ws`, { origin: 'https://evil.example' })),
    ).toEqual({ accept: false, status: 403 });
    expect((await router(upgradeRequest(`${URL_ORIGIN}/ws`, { origin: URL_ORIGIN })))?.accept).toBe(
      true,
    );
  });

  it('leaves a non-WebSocket path to fall through, whatever its Origin', async () => {
    const { service } = build();
    const decision = await service.routeUpgrade(
      upgradeRequest(`${URL_ORIGIN}/other`, { origin: 'https://evil.example' }),
      undefined,
      PUBLIC_ORIGIN,
    );
    expect(decision).toBeNull();
  });
});

describe('refused-origin logging', () => {
  const refuse = (service: WebSocketService, origin: string) =>
    service.routeUpgrade(upgradeRequest(`${URL_ORIGIN}/ws`, { origin }), undefined, PUBLIC_ORIGIN);

  it('logs each distinct refused origin once, at warn, with the route', async () => {
    const { service, logger } = build({ allowedOrigins: [LISTED] });
    await refuse(service, 'https://evil.example');
    await refuse(service, 'https://evil.example');
    await refuse(service, 'https://other.example');
    expect(logger.entries).toEqual([
      {
        level: 'warn',
        message: 'websocket: upgrade refused, origin not allowed',
        metadata: { origin: 'https://evil.example', path: '/ws', allowedOrigins: 1 },
      },
      {
        level: 'warn',
        message: 'websocket: upgrade refused, origin not allowed',
        metadata: { origin: 'https://other.example', path: '/ws', allowedOrigins: 1 },
      },
    ]);
  });

  it('stops after 256 distinct origins with one final line, and truncates each to 256 chars', async () => {
    const { service, logger } = build();
    const long = `https://${'a'.repeat(400)}.example`;
    await refuse(service, long);
    for (let i = 0; i < 300; i++) await refuse(service, `https://o${i}.example`);
    expect(logger.entries).toHaveLength(257);
    expect((logger.entries[0]?.metadata as { origin: string }).origin).toHaveLength(256);
    expect(logger.entries[256]).toEqual({
      level: 'warn',
      message: 'websocket: refused-origin logging stopped',
      metadata: { distinctOrigins: 256 },
    });
  });

  it('refuses without a logger', async () => {
    const service = new WebSocketService(createFakeRuntime(), resolveOptions(), true);
    service.route('/ws', {});
    expect(await refuse(service, 'https://evil.example')).toEqual({ accept: false, status: 403 });
  });
});

describe('allowedOrigins validation', () => {
  const INVALID: ReadonlyArray<readonly [string, unknown]> = [
    ['a string instead of an array', 'https://app.example.com'],
    ['a non-string entry', [42]],
    ['a path', ['https://app.example.com/x']],
    ['a trailing slash', ['https://app.example.com/']],
    ['a query', ['https://app.example.com?x=1']],
    ['a non-http scheme', ['ftp://app.example.com']],
    ['the opaque origin', ['null']],
    ['an unparseable value', ['not a url']],
    ['an upper-case host', ['https://App.example.com']],
    ['a wildcard host, which matches no browser Origin', ['https://*.app.example.com']],
  ];

  for (const [label, value] of INVALID) {
    it(`refuses ${label} at construction`, () => {
      expect(() => resolveOptions({ allowedOrigins: value as readonly string[] })).toThrow(
        /WebSocketPlugin: allowedOrigins/,
      );
    });
  }

  it('names the bad entry by index, not by value', () => {
    expect(() =>
      resolveOptions({ allowedOrigins: [LISTED, 'https://secret.example/path'] }),
    ).toThrow('allowedOrigins[1] must be an absolute http(s) origin');
  });

  it('freezes a valid list, defaults checkOrigin to true and refuses a non-boolean', () => {
    const resolved = resolveOptions({ allowedOrigins: [LISTED, 'http://localhost:5173'] });
    expect(resolved.allowedOrigins).toEqual([LISTED, 'http://localhost:5173']);
    expect(Object.isFrozen(resolved.allowedOrigins)).toBe(true);
    expect(resolved.checkOrigin).toBe(true);
    expect(() => resolveOptions({ checkOrigin: 'false' as unknown as boolean })).toThrow(
      'WebSocketPlugin: checkOrigin must be a boolean.',
    );
  });
});
