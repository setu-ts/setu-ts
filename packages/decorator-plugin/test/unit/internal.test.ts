import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { Constructor } from '@hono-enterprise/common';

import {
  className,
  isHandlerResult,
  joinPaths,
  normalizeMiddleware,
  protoToCtor,
} from '../../src/internal.ts';

describe('internal helpers', () => {
  describe('normalizeMiddleware', () => {
    it('passes through a bare function', () => {
      const fn = () => {};
      expect(normalizeMiddleware(fn)).toBe(fn);
    });

    it('wraps an IMiddleware class', () => {
      let called = false;
      class Guard {
        handle(): void {
          called = true;
        }
      }
      const wrapped = normalizeMiddleware(Guard);
      expect(typeof wrapped).toBe('function');
      // Invoking it constructs a fresh instance and calls handle.
      wrapped({} as never, () => Promise.resolve());
      expect(called).toBe(true);
    });

    it('throws TypeError for a non-function', () => {
      expect(() => normalizeMiddleware(42 as never)).toThrow(TypeError);
    });
  });

  describe('joinPaths', () => {
    it('joins segments with single slashes', () => {
      expect(joinPaths('v1', '/users', '/:id')).toBe('/v1/users/:id');
    });

    it('drops empty segments', () => {
      expect(joinPaths('', '/users', '')).toBe('/users');
    });

    it('returns / for all-empty input', () => {
      expect(joinPaths('', '')).toBe('/');
    });

    it('trims whitespace and duplicate slashes', () => {
      expect(joinPaths(' /a//b ', 'c/')).toBe('/a/b/c');
    });
  });

  describe('isHandlerResult', () => {
    it('returns true for a branded result', () => {
      expect(isHandlerResult({ __handlerResult: true })).toBe(true);
    });

    it('returns false for a plain object', () => {
      expect(isHandlerResult({ ok: true })).toBe(false);
    });

    it('returns false for null', () => {
      expect(isHandlerResult(null)).toBe(false);
    });
  });

  describe('protoToCtor', () => {
    it('returns the constructor of a prototype', () => {
      class C {}
      expect(protoToCtor(C.prototype)).toBe(C);
    });
  });

  describe('className', () => {
    it('returns the name of a named class', () => {
      class MyService {}
      expect(className(MyService)).toBe('MyService');
    });

    it('returns "anonymous" when name is undefined', () => {
      // Simulate a constructor with no `name` (e.g. a minified class) by
      // passing a plain object cast as a Constructor.
      const anon = { name: undefined } as unknown as Constructor;
      expect(className(anon)).toBe('anonymous');
    });
  });
});
