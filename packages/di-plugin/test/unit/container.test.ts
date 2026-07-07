import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { DiContainer } from '../../src/container/container.ts';
import type { ExternalResolver } from '../../src/container/container.ts';

// --- Test doubles ---

class SimpleService {
  readonly tag = 'simple';
}

class WithDeps {
  constructor(readonly dep: SimpleService) {}
}

class MultiDeps {
  constructor(readonly a: SimpleService, readonly b: WithDeps) {}
}

let factoryCounter = 0;
function makeFactoryService(): { id: number } {
  factoryCounter++;
  return { id: factoryCounter };
}

function makeResolver(services: Record<string, unknown>): ExternalResolver {
  return {
    has: (token: string) => token in services,
    resolve: (token: string) => services[token],
  };
}

describe('DiContainer', () => {
  // ---- Value provider ----

  describe('value provider', () => {
    it('resolves a pre-built value', () => {
      const c = new DiContainer({ defaultScope: 'singleton', autoRegister: false });
      c.register('val', { useValue: 42 });

      expect(c.resolve<number>('val')).toBe(42);
    });

    it('returns the same value on every resolve (singleton default)', () => {
      const c = new DiContainer({ defaultScope: 'singleton', autoRegister: false });
      const obj = { x: 1 };
      c.register('obj', { useValue: obj });

      expect(c.resolve('obj')).toBe(obj);
      expect(c.resolve('obj')).toBe(obj);
    });
  });

  // ---- Factory provider ----

  describe('factory provider', () => {
    it('invokes the factory to produce an instance', () => {
      factoryCounter = 0;
      const c = new DiContainer({ defaultScope: 'singleton', autoRegister: false });
      c.register('f', { useFactory: makeFactoryService });

      const inst = c.resolve<{ id: number }>('f');
      expect(inst.id).toBe(1);
    });

    it('caches singleton factory results', () => {
      factoryCounter = 0;
      const c = new DiContainer({ defaultScope: 'singleton', autoRegister: false });
      c.register('f', { useFactory: makeFactoryService });

      const a = c.resolve<{ id: number }>('f');
      const b = c.resolve<{ id: number }>('f');
      expect(a).toBe(b);
    });

    it('does not cache transient factory results', () => {
      factoryCounter = 0;
      const c = new DiContainer({ defaultScope: 'transient', autoRegister: false });
      c.register('f', { useFactory: makeFactoryService });

      const a = c.resolve<{ id: number }>('f');
      const b = c.resolve<{ id: number }>('f');
      expect(a).not.toBe(b);
      expect(a.id).not.toBe(b.id);
    });
  });

  // ---- Class provider ----

  describe('class provider', () => {
    it('instantiates a class with no dependencies', () => {
      const c = new DiContainer({ defaultScope: 'singleton', autoRegister: false });
      c.register('svc', { useClass: SimpleService });

      const inst = c.resolve<SimpleService>('svc');
      expect(inst).toBeInstanceOf(SimpleService);
      expect(inst.tag).toBe('simple');
    });

    it('resolves constructor dependencies from the container', () => {
      const c = new DiContainer({ defaultScope: 'singleton', autoRegister: false });
      c.register('simple', { useClass: SimpleService });
      c.register('dep', { useClass: WithDeps, inject: ['simple'] });

      const dep = c.resolve<WithDeps>('dep');
      expect(dep.dep).toBeInstanceOf(SimpleService);
    });

    it('resolves multi-level constructor dependencies', () => {
      const c = new DiContainer({ defaultScope: 'singleton', autoRegister: false });
      c.register('simple', { useClass: SimpleService });
      c.register('dep', { useClass: WithDeps, inject: ['simple'] });
      c.register('multi', { useClass: MultiDeps, inject: ['simple', 'dep'] });

      const multi = c.resolve<MultiDeps>('multi');
      expect(multi.a).toBeInstanceOf(SimpleService);
      expect(multi.b).toBeInstanceOf(WithDeps);
      expect(multi.b.dep).toBe(multi.a); // same singleton
    });

    it('uses explicitly registered provider over external resolver for inject deps', () => {
      const external = makeResolver({ simple: 'EXTERNAL' });
      const c = new DiContainer({
        defaultScope: 'singleton',
        autoRegister: true,
        externalResolver: external,
      });
      c.register('simple', { useClass: SimpleService });
      c.register('dep', { useClass: WithDeps, inject: ['simple'] });

      const dep = c.resolve<WithDeps>('dep');
      expect(dep.dep).toBeInstanceOf(SimpleService);
    });
  });

  // ---- Lifecycle scopes ----

  describe('singleton scope', () => {
    it('returns the same instance across resolves', () => {
      const c = new DiContainer({ defaultScope: 'singleton', autoRegister: false });
      c.register('s', { useClass: SimpleService }, { scope: 'singleton' });

      expect(c.resolve('s')).toBe(c.resolve('s'));
    });

    it('shares singletons with child scopes', () => {
      const c = new DiContainer({ defaultScope: 'singleton', autoRegister: false });
      c.register('s', { useClass: SimpleService });
      const child = c.createScope();

      expect(c.resolve('s')).toBe(child.resolve<SimpleService>('s'));
    });
  });

  describe('scoped scope', () => {
    it('caches per scope', () => {
      const c = new DiContainer({ defaultScope: 'singleton', autoRegister: false });
      c.register('s', { useClass: SimpleService }, { scope: 'scoped' });

      // Same container = same instance
      expect(c.resolve('s')).toBe(c.resolve('s'));

      // Different scope = different instance
      const child = c.createScope();
      expect(child.resolve<SimpleService>('s')).not.toBe(c.resolve<SimpleService>('s'));

      // Child caches its own
      expect(child.resolve('s')).toBe(child.resolve('s'));
    });
  });

  describe('transient scope', () => {
    it('creates a new instance every resolve', () => {
      const c = new DiContainer({ defaultScope: 'singleton', autoRegister: false });
      c.register('s', { useClass: SimpleService }, { scope: 'transient' });

      expect(c.resolve('s')).not.toBe(c.resolve('s'));
    });
  });

  describe('default scope', () => {
    it('uses the configured default when no scope is given', () => {
      const c = new DiContainer({ defaultScope: 'transient', autoRegister: false });
      c.register('s', { useClass: SimpleService });

      expect(c.resolve('s')).not.toBe(c.resolve('s'));
    });
  });

  // ---- Circular dependency detection ----

  describe('circular dependency', () => {
    it('throws on a direct self-cycle', () => {
      const c = new DiContainer({ defaultScope: 'singleton', autoRegister: false });
      c.register('self', { useFactory: () => c.resolve('self') });

      expect(() => c.resolve('self')).toThrow(/Circular dependency detected/);
    });

    it('throws on an indirect cycle', () => {
      const c = new DiContainer({ defaultScope: 'singleton', autoRegister: false });
      c.register('a', { useFactory: () => c.resolve('b') });
      c.register('b', { useFactory: () => c.resolve('a') });

      expect(() => c.resolve('a')).toThrow(/Circular dependency detected: a → b → a/);
    });
  });

  // ---- Error cases ----

  describe('resolve errors', () => {
    it('throws when resolving an unregistered token (autoRegister off)', () => {
      const c = new DiContainer({ defaultScope: 'singleton', autoRegister: false });
      expect(() => c.resolve('ghost')).toThrow(/No provider registered/);
    });

    it('throws when the token is in neither container nor external resolver', () => {
      const external = makeResolver({});
      const c = new DiContainer({
        defaultScope: 'singleton',
        autoRegister: true,
        externalResolver: external,
      });
      expect(() => c.resolve('ghost')).toThrow(/No provider registered/);
    });
  });

  // ---- has() ----

  describe('has', () => {
    it('returns true for a registered token', () => {
      const c = new DiContainer({ defaultScope: 'singleton', autoRegister: false });
      c.register('x', { useValue: 1 });
      expect(c.has('x')).toBe(true);
    });

    it('returns false for an unregistered token (autoRegister off)', () => {
      const c = new DiContainer({ defaultScope: 'singleton', autoRegister: false });
      expect(c.has('x')).toBe(false);
    });

    it('returns true when autoRegister and external resolver has the token', () => {
      const external = makeResolver({ found: true });
      const c = new DiContainer({
        defaultScope: 'singleton',
        autoRegister: true,
        externalResolver: external,
      });
      expect(c.has('found')).toBe(true);
    });

    it('returns false when autoRegister is off even if external has the token', () => {
      const external = makeResolver({ found: true });
      const c = new DiContainer({
        defaultScope: 'singleton',
        autoRegister: false,
        externalResolver: external,
      });
      expect(c.has('found')).toBe(false);
    });

    it('returns true for parent tokens in a child scope', () => {
      const c = new DiContainer({ defaultScope: 'singleton', autoRegister: false });
      c.register('parent-tok', { useValue: 1 });
      const child = c.createScope();
      expect(child.has('parent-tok')).toBe(true);
    });
  });

  // ---- Auto-registration ----

  describe('autoRegister', () => {
    it('falls back to the external resolver for unregistered tokens', () => {
      const external = makeResolver({ logger: { level: 'info' } });
      const c = new DiContainer({
        defaultScope: 'singleton',
        autoRegister: true,
        externalResolver: external,
      });

      const logger = c.resolve<{ level: string }>('logger');
      expect(logger.level).toBe('info');
    });

    it('caches the external instance after first resolution', () => {
      let resolveCount = 0;
      const external: ExternalResolver = {
        has: () => true,
        resolve: () => {
          resolveCount++;
          return { n: resolveCount };
        },
      };
      const c = new DiContainer({
        defaultScope: 'singleton',
        autoRegister: true,
        externalResolver: external,
      });

      const a = c.resolve<{ n: number }>('ext');
      const b = c.resolve<{ n: number }>('ext');

      // Should return the SAME cached instance, not call the resolver again
      expect(a).toBe(b);
      expect(resolveCount).toBe(1);
    });

    it('explicit DI registration takes precedence over external resolver', () => {
      const external = makeResolver({ tok: 'EXTERNAL' });
      const c = new DiContainer({
        defaultScope: 'singleton',
        autoRegister: true,
        externalResolver: external,
      });
      c.register('tok', { useValue: 'DI' });

      expect(c.resolve<string>('tok')).toBe('DI');
    });

    it('does not fall back when autoRegister is false', () => {
      const external = makeResolver({ tok: 'EXTERNAL' });
      const c = new DiContainer({
        defaultScope: 'singleton',
        autoRegister: false,
        externalResolver: external,
      });

      expect(() => c.resolve('tok')).toThrow(/No provider registered/);
    });

    it('ClassProvider inject deps can resolve from external resolver', () => {
      const external = makeResolver({ simple: new SimpleService() });
      const c = new DiContainer({
        defaultScope: 'singleton',
        autoRegister: true,
        externalResolver: external,
      });
      c.register('dep', { useClass: WithDeps, inject: ['simple'] });

      const dep = c.resolve<WithDeps>('dep');
      expect(dep.dep).toBeInstanceOf(SimpleService);
    });
  });

  // ---- createScope ----

  describe('createScope', () => {
    it('child inherits parent providers', () => {
      const c = new DiContainer({ defaultScope: 'singleton', autoRegister: false });
      c.register('base', { useValue: 'hello' });
      const child = c.createScope();

      expect(child.resolve<string>('base')).toBe('hello');
    });

    it('child can register its own providers', () => {
      const c = new DiContainer({ defaultScope: 'singleton', autoRegister: false });
      const child = c.createScope();
      child.register('child-only', { useValue: 'child' });

      expect(child.resolve<string>('child-only')).toBe('child');
      expect(() => c.resolve('child-only')).toThrow();
    });

    it('child inherits autoRegister configuration', () => {
      const external = makeResolver({ ext: 42 });
      const c = new DiContainer({
        defaultScope: 'singleton',
        autoRegister: true,
        externalResolver: external,
      });
      const child = c.createScope();

      expect(child.resolve<number>('ext')).toBe(42);
    });
  });

  // ---- register duplicate ----

  describe('register duplicate', () => {
    it('throws when registering the same token twice', () => {
      const c = new DiContainer({ defaultScope: 'singleton', autoRegister: false });
      c.register('dup', { useValue: 1 });

      expect(() => c.register('dup', { useValue: 2 })).toThrow(/already registered/);
    });
  });
});
