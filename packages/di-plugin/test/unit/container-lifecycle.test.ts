import { expect, it } from 'vitest';
import { ContainerClosedError, createContainer } from '../../src/index.ts';

it('finding 1: refuses a singleton capturing a scoped dependency from a child', () => {
  class RequestService {}
  class SingletonService {
    constructor(readonly request: RequestService) {}
  }
  const root = createContainer();
  root.register('RequestService', { useClass: RequestService }, { scope: 'scoped' });
  root.register('SingletonService', {
    useClass: SingletonService,
    inject: ['RequestService'],
  });
  expect(() => root.createScope().resolve('SingletonService')).toThrow(
    /captive.*SingletonService.*RequestService/i,
  );
});

it('compiles while open, retries failed graphs, and closes registration', () => {
  const c = createContainer();
  c.register('holder', { useFactory: (value: unknown) => value, inject: ['later'] });
  expect(() => c.resolve('holder')).toThrow(/missing/);
  expect(() => c.close()).toThrow(/missing/);
  c.register('later', { useValue: 42 });
  expect(c.resolve('holder')).toBe(42);
  c.close();
  c.close();
  expect(() => c.register('new', { useValue: 0 })).toThrow(ContainerClosedError);
  const scope = c.createScope();
  scope.register('leaf', { useValue: 1 });
  expect(scope.resolve('leaf')).toBe(1);
  expect(() => scope.register('later', { useValue: 0 })).toThrow(/already registered/);
  expect(() => scope.createScope().register('leaf', { useValue: 0 })).toThrow(/already registered/);
});

it('cannot satisfy a root dependency from a scope-only provider', () => {
  const c = createContainer();
  c.register('parent', { useFactory: () => 1, inject: ['leaf'] });
  const scope = c.createScope();
  scope.register('leaf', { useValue: 1 });
  expect(() => scope.resolve('parent')).toThrow(/missing: parent → leaf/);
  expect(() => c.close()).toThrow(/missing: parent → leaf/);
});

it('refuses shadowing an external singleton leaf from a scope', () => {
  const c = createContainer({
    autoRegister: true,
    externalResolver: { has: (token) => token === 'external', resolve: () => 42 },
  });
  expect(() => c.createScope().register('external', { useValue: 0 })).toThrow(/already registered/);
});
