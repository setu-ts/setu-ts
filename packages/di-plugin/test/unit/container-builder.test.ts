import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type { IContainer } from '@hono-enterprise/common';

import { ContainerBuilder, createContainer } from '../../src/container/container-builder.ts';
import type { ExternalResolver } from '../../src/container/container.ts';

class Repo {
  readonly name = 'repo';
}

class Service {
  constructor(readonly repo: Repo) {}
}

function makeResolver(services: Record<string, unknown>): ExternalResolver {
  return {
    has: (token: string) => token in services,
    resolve: (token: string) => services[token],
  };
}

describe('ContainerBuilder', () => {
  describe('fluent API', () => {
    it('returns this for chaining', () => {
      const b = new ContainerBuilder();
      expect(b.setDefaultScope('transient')).toBe(b);
      expect(b.setAutoRegister(true)).toBe(b);
      expect(b.setExternalResolver(makeResolver({}))).toBe(b);
      expect(b.register('x', { useValue: 1 })).toBe(b);
    });

    it('applies the default scope to providers without an explicit scope', () => {
      const c = new ContainerBuilder()
        .setDefaultScope('transient')
        .register('s', { useClass: Repo })
        .build();

      expect(c.resolve('s')).not.toBe(c.resolve('s'));
    });

    it('honors an explicit scope on a provider even when default differs', () => {
      const c = new ContainerBuilder()
        .setDefaultScope('transient')
        .register('s', { useClass: Repo }, { scope: 'singleton' })
        .build();

      expect(c.resolve('s')).toBe(c.resolve('s'));
    });
  });

  describe('build', () => {
    it('creates a container with all queued registrations', () => {
      const c = new ContainerBuilder()
        .register('repo', { useClass: Repo })
        .register('svc', { useClass: Service, inject: ['repo'] })
        .build();

      const svc = c.resolve<Service>('svc');
      expect(svc).toBeInstanceOf(Service);
      expect(svc.repo).toBeInstanceOf(Repo);
    });

    it('includes value providers', () => {
      const c = new ContainerBuilder()
        .register('val', { useValue: 123 })
        .build();

      expect(c.resolve<number>('val')).toBe(123);
    });

    it('includes factory providers', () => {
      const c = new ContainerBuilder()
        .register('f', { useFactory: () => ({ made: true }) })
        .build();

      expect(c.resolve<{ made: boolean }>('f').made).toBe(true);
    });

    it('propagates duplicate token errors from the container', () => {
      const b = new ContainerBuilder()
        .register('dup', { useValue: 1 })
        .register('dup', { useValue: 2 });

      expect(() => b.build()).toThrow(/already registered/);
    });
  });

  describe('autoRegister', () => {
    it('enables external resolver fallback in the built container', () => {
      const external = makeResolver({ ext: { v: 1 } });
      const c = new ContainerBuilder()
        .setAutoRegister(true)
        .setExternalResolver(external)
        .build();

      expect(c.has('ext')).toBe(true);
      expect(c.resolve<{ v: number }>('ext').v).toBe(1);
    });

    it('disables fallback by default', () => {
      const external = makeResolver({ ext: 1 });
      const c = new ContainerBuilder()
        .setExternalResolver(external)
        .build();

      expect(c.has('ext')).toBe(false);
    });
  });
});

describe('createContainer factory', () => {
  it('creates a working container without options', () => {
    const c: IContainer = createContainer();
    c.register('x', { useValue: 'hello' });
    expect(c.resolve<string>('x')).toBe('hello');
  });

  it('accepts defaultScope', () => {
    const c = createContainer({ defaultScope: 'transient' });
    c.register('s', { useClass: Repo });
    expect(c.resolve('s')).not.toBe(c.resolve('s'));
  });

  it('accepts autoRegister and externalResolver', () => {
    const external = makeResolver({ found: 42 });
    const c = createContainer({
      autoRegister: true,
      externalResolver: external,
    });
    expect(c.resolve<number>('found')).toBe(42);
  });

  it('defaults autoRegister to false', () => {
    const external = makeResolver({ found: 42 });
    const c = createContainer({ externalResolver: external });
    expect(() => c.resolve('found')).toThrow();
  });
});
