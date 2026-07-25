/**
 * Tests for `createFlagGuard` middleware factory.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createFlagGuard } from '../../src/middleware/feature-flag-middleware.ts';
import type {
  FlagContext,
  IFeatureFlags,
  IRequestContext,
  NextFunction,
} from '@hono-enterprise/common';

describe('createFlagGuard', () => {
  function buildCtx(flagOn: boolean, user?: { id: string }, capRegistered = true): {
    ctx: IRequestContext;
    redirectUrl: string | null;
    statusCode: number | null;
    body: string | null;
    nextCalled: boolean;
    wrapNext(fn: () => void): NextFunction;
  } {
    let nextCalledValue = false;
    let redirectUrl: string | null = null;
    let statusCode: number | null = null;
    let body: string | null = null;

    const flags: IFeatureFlags = {
      isEnabled: (_flag: string, _context?: unknown): boolean => {
        void _flag;
        void _context;
        return flagOn;
      },
    };

    const ctx = {
      services: {
        get: <T>(_token: string): T => {
          if (!capRegistered) {
            throw new Error(`Capability not registered: ${_token}`);
          }
          return flags as T;
        },
      },
      request: {
        user: user ? { id: user.id } : undefined,
      },
      response: {
        redirect: (url: string): void => {
          redirectUrl = url;
        },
        status: (code: number): void => {
          statusCode = code;
        },
        text: (t: string): void => {
          body = t;
        },
      },
    } as unknown as IRequestContext;

    return {
      ctx,
      get redirectUrl() {
        return redirectUrl;
      },
      get statusCode() {
        return statusCode;
      },
      get body() {
        return body;
      },
      get nextCalled() {
        return nextCalledValue;
      },
      wrapNext(fn: () => void): NextFunction {
        return (): Promise<void> => {
          nextCalledValue = true;
          fn();
          return Promise.resolve();
        };
      },
    };
  }

  it('flag on ⇒ next() called, no response set', async () => {
    const capture = buildCtx(true, { id: 'user1' });
    const guard = createFlagGuard('beta');
    await guard(
      capture.ctx,
      capture.wrapNext(() => {
        // next invoked — no response should be set
      }),
    );

    expect(capture.redirectUrl).toBeNull();
    expect(capture.statusCode).toBeNull();
    expect(capture.body).toBeNull();
  });

  it('flag off + fallback ⇒ redirect, next() NOT called', async () => {
    const capture = buildCtx(false, { id: 'user1' });
    const guard = createFlagGuard('beta', { fallback: '/old' });
    await guard(capture.ctx, capture.wrapNext(() => {}));

    expect(capture.redirectUrl).toBe('/old');
    expect(capture.nextCalled).toBe(false);
  });

  it('flag off + no fallback ⇒ 404, next() NOT called', async () => {
    const capture = buildCtx(false, { id: 'user1' });
    const guard = createFlagGuard('beta');
    await guard(capture.ctx, capture.wrapNext(() => {}));

    expect(capture.statusCode).toBe(404);
    expect(capture.body).toBe('Not Found');
    expect(capture.nextCalled).toBe(false);
  });

  it('custom statusCode honored', async () => {
    const capture = buildCtx(false, { id: 'user1' });
    const guard = createFlagGuard('beta', { statusCode: 403 });
    await guard(capture.ctx, capture.wrapNext(() => {}));

    expect(capture.statusCode).toBe(403);
    expect(capture.body).toBe('Not Found');
    expect(capture.nextCalled).toBe(false);
  });

  it('context derived from ctx.request.user.id', async () => {
    let receivedContext: FlagContext | undefined;
    const flags: IFeatureFlags = {
      isEnabled: (_flag: string, context?: FlagContext): boolean => {
        receivedContext = context;
        return true;
      },
    };

    const ctx = {
      services: {
        get: <T>(_token: string): T => flags as T,
      },
      request: {
        user: { id: 'auto-user' },
      },
      response: {
        redirect: (): void => {},
        status: (): void => {},
        text: (): void => {},
      },
    } as unknown as IRequestContext;

    const guard = createFlagGuard('beta');
    await guard(ctx, (): Promise<void> => Promise.resolve());

    expect(receivedContext).toEqual({ userId: 'auto-user' });
  });

  it('userId omitted when there is no user', async () => {
    let receivedContext: FlagContext | undefined;
    const flags: IFeatureFlags = {
      isEnabled: (_flag: string, context?: FlagContext): boolean => {
        receivedContext = context;
        return true;
      },
    };

    const ctx = {
      services: {
        get: <T>(_token: string): T => flags as T,
      },
      request: {
        user: undefined,
      },
      response: {
        redirect: (): void => {},
        status: (): void => {},
        text: (): void => {},
      },
    } as unknown as IRequestContext;

    const guard = createFlagGuard('beta');
    await guard(ctx, (): Promise<void> => Promise.resolve());

    expect(receivedContext).toBeUndefined();
  });

  it('options.context overrides user.id', async () => {
    let receivedContext: FlagContext | undefined;
    const flags: IFeatureFlags = {
      isEnabled: (_flag: string, context?: FlagContext): boolean => {
        receivedContext = context;
        return true;
      },
    };

    const ctx = {
      services: {
        get: <T>(_token: string): T => flags as T,
      },
      request: {
        user: { id: 'user-from-request' },
      },
      response: {
        redirect: (): void => {},
        status: (): void => {},
        text: (): void => {},
      },
    } as unknown as IRequestContext;

    const guard = createFlagGuard('beta', { context: { userId: 'override' } });
    await guard(ctx, (): Promise<void> => Promise.resolve());

    expect(receivedContext).toEqual({ userId: 'override' });
  });

  it('unregistered capability ⇒ error propagates, next() NOT called', async () => {
    const capture = buildCtx(true, { id: 'user1' }, false);
    const guard = createFlagGuard('beta');
    let errorThrown = false;
    try {
      await guard(capture.ctx, capture.wrapNext(() => {}));
    } catch {
      errorThrown = true;
    }

    expect(errorThrown).toBe(true);
    expect(capture.nextCalled).toBe(false);
  });
});
