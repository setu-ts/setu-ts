import { beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { Inject, Injectable, Optional } from '../../src/decorators/injection.ts';
import { metadataStore } from '../../src/metadata/metadata-store.ts';
import type { Constructor } from '@setu-ts/common';

describe('@Injectable', () => {
  beforeEach(() => {
    metadataStore.clear();
  });

  it('stores scope and token', () => {
    @Injectable({ scope: 'singleton', token: 'user-service' })
    class Svc {}
    expect(metadataStore.getService(Svc)).toMatchObject({
      scope: 'singleton',
      token: 'user-service',
    });
  });

  it('defaults to no scope/token when options are omitted', () => {
    @Injectable()
    class Svc {}
    const meta = metadataStore.getService(Svc);
    expect(meta).toBeDefined();
    expect(meta?.scope).toBeUndefined();
    expect(meta?.token).toBeUndefined();
  });

  it('last-applied @Injectable wins for scope and token (topmost in source)', () => {
    @Injectable({ token: 'outer' })
    @Injectable({ token: 'inner' })
    class Svc {}
    expect(metadataStore.getService(Svc)?.token).toBe('outer');
  });
});

describe('@Inject', () => {
  beforeEach(() => {
    metadataStore.clear();
  });

  it('records the constructor tokens in argument order', () => {
    @Injectable()
    @Inject('database', 'logger', 'cache')
    class Repository {
      constructor(readonly db: unknown, readonly logger: unknown, readonly cache: unknown) {}
    }
    expect(metadataStore.getService(Repository)?.inject).toEqual([
      'database',
      'logger',
      'cache',
    ]);
  });

  it('records a token list on a class carrying no @Injectable', () => {
    // @Inject writes through mergeService, so it creates the service record
    // itself — a class may declare its dependencies without being registered.
    @Inject('database')
    class Solo {
      constructor(readonly db: unknown) {}
    }
    expect(metadataStore.getService(Solo)?.inject).toEqual(['database']);
  });

  it('reports no inject list for a class that declares none', () => {
    @Injectable()
    class Plain {}
    expect(metadataStore.getService(Plain)?.inject).toBeUndefined();
  });

  it('accepts Optional(token) in the position of the argument it describes', () => {
    @Injectable()
    @Inject('database', Optional('cache'), 'logger')
    class Mixed {
      constructor(readonly db: unknown, readonly cache: unknown, readonly logger: unknown) {}
    }
    // The optional marker contributes its token to the list like any other …
    expect(metadataStore.getService(Mixed)?.inject).toEqual(['database', 'cache', 'logger']);
    // … and additionally marks that one argument absent-tolerant.
    expect([...metadataStore.ctorOptional(Mixed)]).toEqual([1]);
  });

  it('marks nothing optional when every entry is a bare token', () => {
    @Injectable()
    @Inject('database', 'logger')
    class Required {
      constructor(readonly db: unknown, readonly logger: unknown) {}
    }
    expect([...metadataStore.ctorOptional(Required)]).toEqual([]);
  });

  it('the topmost @Inject wins when a class carries two', () => {
    // mergeService replaces `inject` wholesale, and class decorators apply
    // bottom-up, so the one written highest in the source is applied last.
    @Inject('winner')
    @Inject('loser')
    class Doubled {
      constructor(readonly dep: unknown) {}
    }
    expect(metadataStore.getService(Doubled)?.inject).toEqual(['winner']);
  });
});

describe('stacked @Inject declarations', () => {
  /**
   * `mergeService` REPLACES `inject` while the optional set used to ACCUMULATE,
   * so the winning token list could inherit the loser's optional indices. Class
   * decorators apply bottom-up, so the TOP `@Inject` is the one that wins.
   */
  it('lets the last-applied @Inject own both the tokens and the optional set', () => {
    @Inject('a', 'b', 'c')
    @Inject(Optional('x'))
    class Stacked {}

    const target = Stacked as unknown as Constructor;
    expect(metadataStore.getService(target)?.inject).toEqual(['a', 'b', 'c']);
    // Without the replacement, index 0 would still be marked optional here and
    // 'a' would silently resolve to `undefined` when it has no provider.
    expect([...metadataStore.ctorOptional(target)]).toEqual([]);
  });

  it('does not strand an optional index the winning list cannot cover', () => {
    @Inject('only')
    @Inject('p', 'q', Optional('r'))
    class Narrowed {}

    const target = Narrowed as unknown as Constructor;
    expect(metadataStore.getService(target)?.inject).toEqual(['only']);
    // Index 2 would otherwise survive against a one-entry list, which
    // `effectiveOptional` refuses at startup.
    expect([...metadataStore.ctorOptional(target)]).toEqual([]);
  });
});
