import { beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { Inject, Injectable } from '../../src/decorators/injection.ts';
import { metadataStore } from '../../src/metadata/metadata-store.ts';

describe('@Injectable / @Inject', () => {
  beforeEach(() => {
    metadataStore.clear();
  });

  it('stores scope and token', () => {
    @Injectable({ scope: 'singleton', token: 'user-service' })
    class UserService {
      greet() {
        return 'hi';
      }
    }
    const meta = metadataStore.getService(UserService);
    expect(meta?.scope).toBe('singleton');
    expect(meta?.token).toBe('user-service');
    expect(metadataStore.hasService(UserService)).toBe(true);
  });

  it('defaults to no scope/token when options are omitted', () => {
    @Injectable()
    class Svc {
      run() {
        return 1;
      }
    }
    const meta = metadataStore.getService(Svc);
    expect(meta?.scope).toBeUndefined();
    expect(meta?.token).toBeUndefined();
  });

  it('stores constructor injection tokens via @Inject', () => {
    @Injectable()
    @Inject('database', 'logger')
    class Repository {
      constructor(_db: unknown, _logger: unknown) {}
    }
    const meta = metadataStore.getService(Repository);
    expect(meta?.inject).toEqual(['database', 'logger']);
  });

  it('assembles parameter-level @Inject in declaration order despite reverse evaluation', () => {
    @Injectable()
    class Repository {
      constructor(
        @Inject('database') readonly db: unknown,
        @Inject('logger') readonly logger: unknown,
        @Inject('cache') readonly cache: unknown,
      ) {}
    }
    // Constructor parameter decorators evaluate right-to-left, so an appending
    // implementation would yield ['cache', 'logger', 'database'] here.
    expect(metadataStore.ctorInject(Repository)).toEqual(['database', 'logger', 'cache']);
    // The parameter form must NOT write the class-level field.
    expect(metadataStore.getService(Repository)?.inject).toBeUndefined();
  });

  it('records a single parameter-level token without touching class metadata', () => {
    class Solo {
      constructor(@Inject('database') readonly db: unknown) {}
    }
    expect(metadataStore.ctorInject(Solo)).toEqual(['database']);
  });

  it('returns undefined for a class with no parameter-level @Inject', () => {
    @Injectable()
    class Plain {
      run() {
        return 1;
      }
    }
    expect(metadataStore.ctorInject(Plain)).toBeUndefined();
  });

  it('the leftmost decorator wins when one parameter carries two @Inject', () => {
    class Doubled {
      constructor(@Inject('winner') @Inject('loser') readonly dep: unknown) {}
    }
    expect(metadataStore.ctorInject(Doubled)).toEqual(['winner']);
  });

  it('throws when @Inject is applied to a method parameter', () => {
    expect(() => {
      class Bad {
        run(@Inject('database') _db: unknown): void {}
      }
      return Bad;
    }).toThrow(/only valid on a constructor parameter/);
  });

  it('names the offending method in the method-parameter error', () => {
    expect(() => {
      class Bad {
        handle(@Inject('database') _db: unknown): void {}
      }
      return Bad;
    }).toThrow(/method "handle"/);
  });

  it('throws when the parameter position receives more than one token', () => {
    expect(() => {
      class Bad {
        constructor(@Inject('a', 'b') readonly dep: unknown) {}
      }
      return Bad;
    }).toThrow(/exactly one token, but received 2/);
  });

  it('throws when the parameter position receives no token', () => {
    expect(() => {
      class Bad {
        constructor(@Inject() readonly dep: unknown) {}
      }
      return Bad;
    }).toThrow(/exactly one token, but received 0/);
  });

  it('the class form still records the positional list unchanged', () => {
    @Injectable()
    @Inject('database', 'logger')
    class Legacy {
      constructor(_db: unknown, _logger: unknown) {}
    }
    expect(metadataStore.getService(Legacy)?.inject).toEqual(['database', 'logger']);
    expect(metadataStore.ctorInject(Legacy)).toBeUndefined();
  });

  it('last-applied @Injectable wins for scope and token (topmost in source)', () => {
    @Injectable({ scope: 'singleton', token: 'final' })
    @Injectable({ scope: 'transient', token: 'first' })
    class Svc {
      run() {
        return 1;
      }
    }
    const meta = metadataStore.getService(Svc);
    expect(meta?.scope).toBe('singleton');
    expect(meta?.token).toBe('final');
  });
});
