import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { CircularDetector } from '../../src/container/circular-detector.ts';

describe('CircularDetector', () => {
  describe('enter / leave', () => {
    it('accepts a token that is not already in the chain', () => {
      const det = new CircularDetector();
      det.enter('a');
      expect(det.isActive).toBe(true);
      det.leave();
      expect(det.isActive).toBe(false);
    });

    it('accepts a token re-entered after leaving', () => {
      const det = new CircularDetector();
      det.enter('a');
      det.leave();
      det.enter('a'); // should not throw
      det.leave();
    });

    it('leave on an empty stack is a safe no-op', () => {
      const det = new CircularDetector();
      det.leave(); // no throw
      expect(det.isActive).toBe(false);
    });
  });

  describe('cycle detection', () => {
    it('throws on a direct self-cycle (A → A)', () => {
      const det = new CircularDetector();
      det.enter('a');
      expect(() => det.enter('a')).toThrow(/Circular dependency detected: a → a/);
    });

    it('throws on an indirect cycle (A → B → A)', () => {
      const det = new CircularDetector();
      det.enter('a');
      det.enter('b');
      expect(() => det.enter('a')).toThrow(/Circular dependency detected: a → b → a/);
    });

    it('throws on a longer cycle (A → B → C → B)', () => {
      const det = new CircularDetector();
      det.enter('a');
      det.enter('b');
      det.enter('c');
      expect(() => det.enter('b')).toThrow(/Circular dependency detected: b → c → b/);
    });

    it('does not throw for a diamond (not a cycle)', () => {
      //     A
      //    / \
      //   B   C
      //    \ /
      //     D
      const det = new CircularDetector();
      det.enter('a');
      det.enter('b');
      det.enter('d');
      det.leave(); // d
      det.enter('c');
      det.enter('d'); // re-entering d is fine — it was left
      det.leave(); // d
      det.leave(); // c
      det.leave(); // b
      det.leave(); // a
    });
  });

  describe('isActive', () => {
    it('is false on a fresh detector', () => {
      expect(new CircularDetector().isActive).toBe(false);
    });

    it('is true while tokens are active', () => {
      const det = new CircularDetector();
      det.enter('x');
      expect(det.isActive).toBe(true);
    });
  });
});
