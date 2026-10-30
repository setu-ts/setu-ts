import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { createToken } from '@setu-ts/common';

import { DiContainer } from '../../src/container/container.ts';
import type { ExternalResolver } from '../../src/container/container.ts';
import { Compiler } from '../../src/container/compiler.ts';
import { ProviderRegistry } from '../../src/container/provider-registry.ts';

it('M125 lazy scope: untouched scopes resolve, inspect and validate through the ancestor compiler', () => {
  const root = new DiContainer({ defaultScope: 'singleton', autoRegister: false });
  root.register('root', { useValue: 42 });
  const compile = vi.spyOn(Compiler.prototype, 'compile');
  const validate = vi.spyOn(Compiler.prototype, 'compileAll');
  const inspect = vi.spyOn(Compiler.prototype, 'has');
  const childRegistry = vi.spyOn(ProviderRegistry.prototype, 'createChild');
  try {
    root.resolve('root');
    const compiler = compile.mock.contexts[0];
    compile.mockClear();
    const parent = root.createScope() as DiContainer;
    const child = parent.createScope() as DiContainer;
    expect(childRegistry).not.toHaveBeenCalled();
    expect(child.resolve('root')).toBe(42);
    expect(compile.mock.contexts).toEqual([compiler]);
    expect(child.has('root')).toBe(true);
    expect(inspect.mock.contexts).toEqual([compiler]);
    child.close();
    expect(validate.mock.contexts).toEqual([compiler]);
    expect(child.opaqueTokens()).toEqual([]);
    expect(childRegistry).not.toHaveBeenCalled();
    expect(child.dispose()).toBeUndefined();
  } finally {
    compile.mockRestore();
    validate.mockRestore();
    inspect.mockRestore();
    childRegistry.mockRestore();
  }
});

it('M125 lazy scope: registering after inherited resolution keeps root slots separate from local instances', () => {
  const root = new DiContainer({ defaultScope: 'singleton', autoRegister: false });
  root.register('root', { useFactory: () => ({ root: true }) }, { scope: 'scoped' });
  root.close();
  const parent = root.createScope() as DiContainer;
  const child = parent.createScope() as DiContainer;
  const inherited = child.resolve('root');
  expect(child.localInstances).toBeUndefined();
  child.register('local', { useFactory: () => ({ local: true }) }, { scope: 'scoped' });
  const local = child.resolve('local');
  expect(child.resolve('root')).toBe(inherited);
  expect(child.resolve('local')).toBe(local);
  let undefinedCreates = 0;
  child.register(
    'undefined-local',
    {
      useFactory: () => {
        undefinedCreates++;
        return undefined;
      },
    },
    { scope: 'scoped' },
  );
  child.resolve('undefined-local');
  child.resolve('undefined-local');
  expect(undefinedCreates).toBe(1);
  class LocalService {}
  const recipe = { useClass: LocalService };
  const dispose = vi.fn();
  child.register('class-local', recipe, { scope: 'scoped', dispose });
  child.register(LocalService, recipe, { scope: 'scoped', dispose });
  expect(child.resolve(LocalService)).toBe(child.resolve('class-local'));
  expect(child.localInstances?.size).toBe(3);
  expect(child.slots).toEqual([inherited]);
  expect(parent.slots).toBeUndefined();
  child.dispose();
  expect(child.slots).toBeUndefined();
  expect(child.localInstances).toBeUndefined();
  expect(dispose).toHaveBeenCalledOnce();
});

it('M125 obligation 13: parent registrations after child creation cannot collide with child registrations', () => {
  const root = new DiContainer({ defaultScope: 'singleton', autoRegister: false });
  const parent = root.createScope();
  const child = parent.createScope();
  // Register in the child first: a still-empty parent must remain visible when it registers later.
  child.register('child', { useFactory: () => ({ owner: 'child' }) }, { scope: 'scoped' });
  parent.register('parent', { useFactory: () => ({ owner: 'parent' }) }, { scope: 'scoped' });
  const parentValue = parent.resolve('parent');
  const inherited = child.resolve('parent');
  const childValue = child.resolve('child');
  expect(inherited).not.toBe(parentValue);
  expect(inherited).not.toBe(childValue);
  expect(child.resolve('parent')).toBe(inherited);
  expect(child.resolve('child')).toBe(childValue);
  const nested = child.createScope();
  expect(nested.resolve('parent')).not.toBe(inherited);
  expect(nested.resolve('child')).not.toBe(childValue);
  expect(parent.has('child')).toBe(false);
  nested.dispose();
  child.dispose();
  parent.dispose();
  root.dispose();
});

it('M125 untouched scope: inherited lifetime refusals, isolation and disposal remain unchanged', () => {
  const root = new DiContainer({
    defaultScope: 'singleton',
    autoRegister: true,
    externalResolver: makeResolver({ external: {} }),
  });
  const dispose = vi.fn();
  root.register('scoped', { useFactory: () => ({}) }, { scope: 'scoped', dispose });
  root.register('single', { useFactory: () => ({}) });
  root.register('transient', { useFactory: () => ({}) }, { scope: 'transient', dispose });
  root.close();
  const scope = root.createScope();
  const nested = scope.createScope();
  expect(() => root.resolve('scoped')).toThrow(/requires a scope/);
  expect(() => root.resolve('transient')).toThrow(/requires a scope/);
  expect(scope.has('scoped')).toBe(true);
  expect(scope.has('absent')).toBe(false);
  expect(scope.resolve('single')).toBe(root.resolve('single'));
  expect(nested.resolve('external')).toBe(scope.resolve('external'));
  expect(nested.resolve('scoped')).not.toBe(scope.resolve('scoped'));
  scope.resolve('transient');
  nested.dispose();
  scope.dispose();
  expect(dispose).toHaveBeenCalledTimes(3);
  expect(() => scope.resolve('single')).toThrow(/disposed/);
  root.dispose();
  expect(() => root.createScope().resolve('single')).toThrow(/disposed/);
});

// --- Test doubles ---

class SimpleService {
  readonly tag = 'simple';
}

class WithDeps {
  constructor(readonly dep: SimpleService) {}
}

class MultiDeps {
  constructor(
    readonly a: SimpleService,
    readonly b: WithDeps,
  ) {}
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
  it('infers typed and class tokens, including distinct tokens with the same name', () => {
    const c = new DiContainer({ defaultScope: 'singleton', autoRegister: false });
    const first = createToken<number>('same');
    const second = createToken<string>('same');
    c.register(first, { useValue: 1 });
    c.register(second, { useValue: 'two' });
    c.register(SimpleService, { useClass: SimpleService });
    expectTypeOf(c.resolve(first)).toEqualTypeOf<number>();
    expectTypeOf(c.resolve(SimpleService)).toEqualTypeOf<SimpleService>();
    expect(c.resolve(first)).toBe(1);
    expect(c.resolve(second)).toBe('two');
    expect(c.resolve(SimpleService)).toBeInstanceOf(SimpleService);
    expect(c.has(first)).toBe(true);
  });

  it('shares a compiled class alias and resolves minified classes by identity', () => {
    const c = new DiContainer({ defaultScope: 'singleton', autoRegister: false });
    const a = class {
      readonly value = 1;
    };
    const provider = { useClass: a };
    c.register('service', provider);
    c.register(a, provider);
    expect(c.resolve(a)).toBe(c.resolve('service'));
    expect(c.resolve(a).value).toBe(1);
  });

  it('passes factory dependencies in order and absent optional values as undefined', () => {
    const c = new DiContainer({ defaultScope: 'singleton', autoRegister: false });
    c.register('a', { useValue: 1 });
    c.register('factory', {
      useFactory: (a: number, missing: unknown) => [a, missing],
      inject: ['a', { token: 'missing', optional: true }],
    });
    expect(c.resolve('factory')).toEqual([1, undefined]);
  });

  it('refuses a transient reaching scoped on the root and gives nested scopes fresh slots', () => {
    const c = new DiContainer({ defaultScope: 'singleton', autoRegister: false });
    c.register('scoped', { useFactory: () => ({}) }, { scope: 'scoped' });
    c.register(
      'transient',
      { useFactory: (value: unknown) => value, inject: ['scoped'] },
      { scope: 'transient' },
    );
    expect(() => c.resolve('transient')).toThrow(/transient.*requires a scope/);
    const scope = c.createScope();
    expect(scope.resolve('transient')).toBe(scope.resolve('scoped'));
    expect(scope.createScope().resolve('scoped')).not.toBe(scope.resolve('scoped'));
  });

  it('caches undefined singleton and scoped values and retries failed constructors', () => {
    const c = new DiContainer({ defaultScope: 'singleton', autoRegister: false });
    let calls = 0;
    c.register('retry', {
      useFactory: () => {
        if (++calls === 1) throw new Error('retry');
        return undefined;
      },
    });
    expect(() => c.resolve('retry')).toThrow('retry');
    expect(c.resolve('retry')).toBeUndefined();
    expect(c.resolve('retry')).toBeUndefined();
    expect(calls).toBe(2);
    let scoped = 0;
    c.register(
      'undefined',
      {
        useFactory: () => {
          scoped++;
          return undefined;
        },
      },
      { scope: 'scoped' },
    );
    const scope = c.createScope();
    scope.resolve('undefined');
    scope.resolve('undefined');
    expect(scoped).toBe(1);
  });
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

      expect(() => c.resolve('s')).toThrow(/requires a scope/);
      const child = c.createScope();
      const second = c.createScope();
      expect(child.resolve('s')).not.toBe(second.resolve('s'));
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
      c.register('self', { useFactory: (value: unknown) => value, inject: ['self'] });

      expect(() => c.resolve('self')).toThrow(/cycle: self → self/);
    });

    it('throws on an indirect cycle', () => {
      const c = new DiContainer({ defaultScope: 'singleton', autoRegister: false });
      c.register('a', { useFactory: (value: unknown) => value, inject: ['b'] });
      c.register('b', { useFactory: (value: unknown) => value, inject: ['a'] });

      expect(() => c.resolve('a')).toThrow(/cycle: a → b → a/);
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
