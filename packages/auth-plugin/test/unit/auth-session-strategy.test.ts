import { expect, it } from 'vitest';
import type { IRequest, ISessionService } from '@setu-ts/common';
import { AuthSessionStrategy } from '../../src/strategies/auth-session-strategy.ts';
import { AUTH_SESSION_KEY } from '../../src/sign-in/auth-session-service.ts';
import { digestSessionStamp, sessionStampRevocations } from '../../src/sign-in/session-stamp.ts';
it.each(['match', 'mismatch', 'reader-fault'] as const)(
  'M131b 3.13 marks only a definite mismatch: %s',
  async (result) => {
    const check = { subtle: crypto.subtle, read: () => 'v1' };
    const record = {
      principal: { id: 'u' },
      methods: ['pwd'],
      at: 1,
      stamp: await digestSessionStamp(check, { id: 'u' }),
    };
    const strategy = new AuthSessionStrategy({
      sessionService: {
        fromHeaders: () => Promise.resolve({ id: 's', data: { [AUTH_SESSION_KEY]: record } }),
      } as unknown as ISessionService,
      sessionStamp: {
        subtle: crypto.subtle,
        read: () => {
          if (result === 'reader-fault') throw new Error('offline');
          return result === 'match' ? 'v1' : 'v2';
        },
      },
    });
    const request = { headers: new Headers() } as IRequest;
    const principal = await strategy.authenticate(request);
    expect(principal?.id ?? null).toBe(result === 'match' ? 'u' : null);
    expect(sessionStampRevocations.has(request)).toBe(result === 'mismatch');
  },
);
