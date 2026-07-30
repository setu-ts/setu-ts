/**
 * Unit tests for the Session object and its expiry validation.
 *
 * The clock is injected throughout: expiry is compared against a wall-clock
 * reading, and a test that used the real clock could not exercise the boundary.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import {
  createSession,
  parseSnapshot,
  restoreSession,
  Session,
} from '../../../src/services/session.ts';
import { makeClock } from '../../fixtures/context.ts';

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;

describe('createSession', () => {
  it('creates an empty session marked new, expiring after maxAge', () => {
    const clock = makeClock(NOW);
    const session = createSession(NOW, HOUR, clock.uuid);

    expect(session.isNew).toBe(true);
    expect(session.id).toBe('id-1');
    expect(session.expiresAt).toBe(NOW + HOUR);
    expect(session.lastSeen).toBe(NOW);
    expect(session.isDirty).toBe(false);
    expect(session.toJSON()).toEqual({});
  });
});

describe('Session data access', () => {
  const build = () => {
    const clock = makeClock(NOW);
    return createSession(NOW, HOUR, clock.uuid);
  };

  it('reads back what it writes and marks itself dirty', () => {
    const session = build();
    expect(session.isDirty).toBe(false);

    session.set('userId', 'u-1');
    expect(session.get<string>('userId')).toBe('u-1');
    expect(session.isDirty).toBe(true);
  });

  it('leaves a session clean when only read', () => {
    const session = build();
    expect(session.get('missing')).toBe(undefined);
    expect(session.has('missing')).toBe(false);
    expect(session.isDirty).toBe(false);
  });

  it('reports presence with has()', () => {
    const session = build();
    session.set('a', 1);
    expect(session.has('a')).toBe(true);
    expect(session.has('b')).toBe(false);
  });

  it('treats setting undefined as a removal, so has() survives a round-trip', () => {
    const session = build();
    session.set('a', 1);
    expect(session.has('a')).toBe(true);

    session.set('a', undefined);

    // Storing `undefined` would make has() report a key that JSON.stringify
    // drops, so presence would flip from true to false across a commit.
    expect(session.has('a')).toBe(false);
    expect(session.get('a')).toBe(undefined);
    expect(session.toJSON()).toEqual({});
  });

  it('setting undefined on an absent key leaves the session clean', () => {
    const session = build();
    session.set('never-there', undefined);
    expect(session.isDirty).toBe(false);
  });

  it('deletes only present keys, and dirties only on a real removal', () => {
    const session = build();
    session.set('a', 1);

    const fresh = build();
    expect(fresh.delete('nope')).toBe(false);
    expect(fresh.isDirty).toBe(false);

    expect(session.delete('a')).toBe(true);
    expect(session.has('a')).toBe(false);
  });

  it('clear() empties the data but keeps the id', () => {
    const session = build();
    const id = session.id;
    session.set('a', 1);
    session.clear();

    expect(session.toJSON()).toEqual({});
    expect(session.id).toBe(id);
    expect(session.isDestroyed).toBe(false);
  });

  it('toJSON returns a detached deep copy', () => {
    const session = build();
    session.set('nested', { deep: { value: 1 } });

    const snapshot = session.toJSON() as { nested: { deep: { value: number } } };
    snapshot.nested.deep.value = 99;

    expect(
      (session.get<{ deep: { value: number } }>('nested'))?.deep.value,
    ).toBe(1);
  });

  it('does not copy the initial data by reference', () => {
    const clock = makeClock(NOW);
    const data = { a: 1 };
    const session = new Session({ id: 'x', data, exp: NOW + HOUR, seen: NOW }, false, clock.uuid);
    data.a = 2;
    expect(session.get<number>('a')).toBe(1);
  });
});

describe('Session.regenerate', () => {
  it('mints a new id, keeps the data, and remembers the previous id', () => {
    const clock = makeClock(NOW);
    const session = createSession(NOW, HOUR, clock.uuid);
    const original = session.id;
    session.set('userId', 'u-1');

    session.regenerate();

    expect(session.id).not.toBe(original);
    expect(session.previousId).toBe(original);
    expect(session.wasRegenerated).toBe(true);
    expect(session.get<string>('userId')).toBe('u-1');
  });

  it('keeps the ORIGINAL previous id across repeated regeneration', () => {
    const clock = makeClock(NOW);
    const session = createSession(NOW, HOUR, clock.uuid);
    const original = session.id;

    session.regenerate();
    session.regenerate();

    // Only the original id was ever persisted server-side, so that is the one
    // the commit path must delete.
    expect(session.previousId).toBe(original);
  });

  it('reports no previous id when never regenerated', () => {
    const clock = makeClock(NOW);
    expect(createSession(NOW, HOUR, clock.uuid).previousId).toBe(null);
  });
});

describe('Session.destroy', () => {
  it('clears the data and flags the session destroyed', () => {
    const clock = makeClock(NOW);
    const session = createSession(NOW, HOUR, clock.uuid);
    session.set('a', 1);

    session.destroy();

    expect(session.isDestroyed).toBe(true);
    expect(session.toJSON()).toEqual({});
  });
});

describe('Session.touch / extend / snapshot', () => {
  it('records activity and moves expiry', () => {
    const clock = makeClock(NOW);
    const session = createSession(NOW, HOUR, clock.uuid);

    session.touch(NOW + 1000);
    session.extend(NOW + 2 * HOUR);

    expect(session.lastSeen).toBe(NOW + 1000);
    expect(session.expiresAt).toBe(NOW + 2 * HOUR);
  });

  it('snapshots the full serializable state', () => {
    const clock = makeClock(NOW);
    const session = createSession(NOW, HOUR, clock.uuid);
    session.set('a', 1);

    expect(session.snapshot()).toEqual({
      id: session.id,
      data: { a: 1 },
      exp: NOW + HOUR,
      seen: NOW,
    });
  });
});

describe('restoreSession', () => {
  const clock = makeClock(NOW);
  const snapshot = { id: 's-1', data: { a: 1 }, exp: NOW + HOUR, seen: NOW };

  it('restores a live session, not marked new', () => {
    const session = restoreSession(snapshot, NOW, clock.uuid);
    expect(session).not.toBe(null);
    expect(session?.isNew).toBe(false);
    expect(session?.id).toBe('s-1');
    expect(session?.get<number>('a')).toBe(1);
    expect(session?.isDirty).toBe(false);
  });

  it('rejects an expired session', () => {
    expect(restoreSession(snapshot, NOW + HOUR + 1, clock.uuid)).toBe(null);
  });

  it('rejects a session expiring exactly now', () => {
    // `exp <= now` — a session must not survive its own expiry instant.
    expect(restoreSession(snapshot, NOW + HOUR, clock.uuid)).toBe(null);
  });

  it('rejects a session idle longer than the timeout', () => {
    expect(restoreSession(snapshot, NOW + 60_001, clock.uuid, 60_000)).toBe(null);
  });

  it('accepts a session idle exactly at the timeout', () => {
    expect(restoreSession(snapshot, NOW + 60_000, clock.uuid, 60_000)).not.toBe(null);
  });

  it('ignores idleness when no timeout is configured', () => {
    expect(restoreSession(snapshot, NOW + HOUR - 1, clock.uuid)).not.toBe(null);
  });
});

describe('parseSnapshot', () => {
  const valid = JSON.stringify({ id: 's-1', data: { a: 1 }, exp: 2, seen: 1 });

  it('parses a well-formed payload', () => {
    expect(parseSnapshot(valid)).toEqual({ id: 's-1', data: { a: 1 }, exp: 2, seen: 1 });
  });

  it('defaults absent data to an empty object, as the store strategy writes', () => {
    const snapshot = parseSnapshot(JSON.stringify({ id: 's-1', exp: 2, seen: 1 }));
    expect(snapshot?.data).toEqual({});
  });

  it('rejects every malformed payload', () => {
    const cases: readonly (readonly [string, string])[] = [
      ['not json', 'not json at all'],
      ['null', 'null'],
      ['an array', '[]'],
      ['a string', '"hello"'],
      ['a number', '42'],
      ['missing id', JSON.stringify({ exp: 2, seen: 1 })],
      ['empty id', JSON.stringify({ id: '', exp: 2, seen: 1 })],
      ['non-string id', JSON.stringify({ id: 5, exp: 2, seen: 1 })],
      ['missing exp', JSON.stringify({ id: 'a', seen: 1 })],
      ['missing seen', JSON.stringify({ id: 'a', exp: 2 })],
      ['non-numeric exp', JSON.stringify({ id: 'a', exp: 'soon', seen: 1 })],
      ['NaN exp', '{"id":"a","exp":null,"seen":1}'],
      ['array data', JSON.stringify({ id: 'a', exp: 2, seen: 1, data: [] })],
      ['null data', JSON.stringify({ id: 'a', exp: 2, seen: 1, data: null })],
      ['scalar data', JSON.stringify({ id: 'a', exp: 2, seen: 1, data: 5 })],
    ];

    for (const [label, payload] of cases) {
      expect(parseSnapshot(payload), label).toBe(null);
    }
  });
});
