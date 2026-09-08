import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { ISessionStore, SessionData } from '@setu-ts/common';

import { deriveKeyRing } from '../../src/codec/crypto.ts';
import { resolveSessionConfig } from '../../src/options.ts';
import { SessionService } from '../../src/services/session-service.ts';
import { makeClock, makeContext } from '../fixtures/context.ts';

const SECRET = 's'.repeat(32);

class SnapshotStore implements ISessionStore {
  readonly entries = new Map<string, SessionData>();

  read(id: string): Promise<SessionData | null> {
    return Promise.resolve(this.entries.get(id) ?? null);
  }
  write(id: string, data: SessionData, _ttlMs: number): Promise<void> {
    this.entries.set(id, { ...data });
    return Promise.resolve();
  }
  destroy(id: string): Promise<boolean> {
    return Promise.resolve(this.entries.delete(id));
  }
}

async function createService(store?: ISessionStore): Promise<SessionService> {
  const clock = makeClock();
  const config = resolveSessionConfig({ mode: 'encrypt' });
  const ring = await deriveKeyRing(crypto.subtle, [SECRET], 'encrypt');
  return new SessionService(config, ring, {
    subtle: crypto.subtle,
    randomBytes: (length) => crypto.getRandomValues(new Uint8Array(length)),
    now: clock.now,
    uuid: clock.uuid,
  }, store);
}

async function seededCookie(service: SessionService): Promise<string> {
  const initial = makeContext();
  const session = await service.load(initial.ctx);
  session.set('seed', true);
  await service.commit(initial.ctx, session);
  return initial.response.setCookies()[0].split(';')[0];
}

describe('session concurrent writes', () => {
  it('keeps only the last returned cookie snapshot for overlapping cookie sessions', async () => {
    const service = await createService();
    const cookie = await seededCookie(service);
    const first = makeContext({ headers: { cookie } });
    const second = makeContext({ headers: { cookie } });
    const firstSession = await service.load(first.ctx);
    const secondSession = await service.load(second.ctx);

    firstSession.set('first', true);
    secondSession.set('second', true);
    await service.commit(first.ctx, firstSession);
    await service.commit(second.ctx, secondSession);

    const finalCookie = second.response.setCookies()[0].split(';')[0];
    const restored = await service.load(makeContext({ headers: { cookie: finalCookie } }).ctx);
    expect(restored.get('first')).toBeUndefined();
    expect(restored.get('second')).toBe(true);
  });

  it('overwrites the shared snapshot for overlapping store-backed sessions too', async () => {
    const store = new SnapshotStore();
    const service = await createService(store);
    const cookie = await seededCookie(service);
    const first = makeContext({ headers: { cookie } });
    const second = makeContext({ headers: { cookie } });
    const firstSession = await service.load(first.ctx);
    const secondSession = await service.load(second.ctx);

    firstSession.set('first', true);
    secondSession.set('second', true);
    await service.commit(first.ctx, firstSession);
    await service.commit(second.ctx, secondSession);

    const restored = await service.load(makeContext({ headers: { cookie } }).ctx);
    expect(restored.get('first')).toBeUndefined();
    expect(restored.get('second')).toBe(true);
  });
});
