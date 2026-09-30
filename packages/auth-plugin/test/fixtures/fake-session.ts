/**
 * A minimal in-memory {@linkcode ISession} for unit tests.
 *
 * `set`/`delete` are recorded so a test can assert the plugin marked the session
 * for commit, and `id` changes on `regenerate` so session-fixation behaviour is
 * observable. Payload values round-trip through JSON, as the real strategies do,
 * so a test cannot accidentally rely on storing a non-serializable value.
 */

import type { IRequestContext, ISession, ISessionService } from '@setu-ts/common';

/** A fake session with its mutation log attached. */
export interface FakeSession extends ISession {
  /** Every write and removal, in order. */
  readonly mutations: string[];
  /** Whether {@linkcode ISession.destroy} has been called. */
  readonly destroyed: boolean;
}

/**
 * Creates a fake session.
 *
 * @param initial - Initial payload, as a fresh cookie-less request would have
 * @param id - The session id to start with
 * @returns The fake session handle
 */
export function createFakeSession(
  initial: Record<string, unknown> = {},
  id = 'session-1',
): FakeSession {
  let data: Record<string, unknown> = structuredClone(initial);
  let currentId = id;
  let destroyed = false;
  const mutations: string[] = [];

  const session: FakeSession = {
    get id() {
      return currentId;
    },
    isNew: false,
    get mutations() {
      return mutations;
    },
    get destroyed() {
      return destroyed;
    },
    get<T>(key: string): T | undefined {
      return data[key] as T | undefined;
    },
    set<T>(key: string, value: T): void {
      if (value === undefined) {
        delete data[key];
      } else {
        // Round-trip so a test sees exactly what a cookie or store would return.
        data[key] = JSON.parse(JSON.stringify(value));
      }
      mutations.push(`set:${key}`);
    },
    has(key: string): boolean {
      return key in data;
    },
    delete(key: string): boolean {
      const had = key in data;
      delete data[key];
      mutations.push(`delete:${key}`);
      return had;
    },
    clear(): void {
      data = {};
      mutations.push('clear');
    },
    regenerate(): void {
      currentId = `${currentId}-rotated`;
      mutations.push('regenerate');
    },
    destroy(): void {
      data = {};
      destroyed = true;
      mutations.push('destroy');
    },
    toJSON(): Record<string, unknown> {
      return { ...data };
    },
  };
  return session;
}

/**
 * A fake `ISessionService` that hands the given session to every `from` call,
 * standing in for the middleware having loaded it onto the request.
 *
 * @param session - The session a request carries
 * @returns A session service whose `from` returns that session
 */
export function createFakeSessionService(session: ISession): ISessionService {
  return {
    from: (_ctx: IRequestContext) => session,
    fromHeaders: () => Promise.resolve({ id: session.id, data: session.toJSON() }),
  } as ISessionService;
}
