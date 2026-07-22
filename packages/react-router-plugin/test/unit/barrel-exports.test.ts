/**
 * Barrel-export tests — every planned export is present.
 *
 * Mirrors the sibling `barrel-exports.test.ts` pattern from other plugins.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  assembleHandler,
  bridgeRequestToRR,
  CAPABILITIES,
  createStaticAssetHandler,
  loadRequestHandler,
  ReactRouterPlugin,
  SsrService,
} from '../../src/index.ts';
import type {
  LoadContextFunction,
  ReactRouterPluginOptions,
  SsrRequestHandler,
} from '../../src/index.ts';

describe('barrel exports', () => {
  it('exports ReactRouterPlugin factory function', () => {
    expect(typeof ReactRouterPlugin).toBe('function');
  });

  it('exports SsrService class', () => {
    expect(typeof SsrService).toBe('function');
  });

  it('exports createStaticAssetHandler factory', () => {
    expect(typeof createStaticAssetHandler).toBe('function');
  });

  it('exports assembleHandler pure seam', () => {
    expect(typeof assembleHandler).toBe('function');
  });

  it('exports loadRequestHandler', () => {
    expect(typeof loadRequestHandler).toBe('function');
  });

  it('exports bridgeRequestToRR', () => {
    expect(typeof bridgeRequestToRR).toBe('function');
  });

  it('re-exports CAPABILITIES constant with SSR token', () => {
    expect(CAPABILITIES).toBeDefined();
    expect(CAPABILITIES.SSR).toBe('ssr');
  });

  it('type exports resolve (compile-time check)', () => {
    // These lines exist solely to type-check that the re-exported types compile.
    const _opt: ReactRouterPluginOptions = {
      serverBuildPath: './build/server',
    };
    const _lc: LoadContextFunction = (_ctx: unknown) => ({});
    void _lc;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const _handler: SsrRequestHandler = async (_r: Request, _c: unknown) => new Response('ok');
    void _handler;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const _svc: import('@hono-enterprise/common').ISsrService =
      {} as import('@hono-enterprise/common').ISsrService;
    void _svc;

    expect(_opt.serverBuildPath).toBe('./build/server');
  });
});
