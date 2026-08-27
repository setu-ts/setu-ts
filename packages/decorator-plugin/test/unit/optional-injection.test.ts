import { beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { Inject, Injectable, Optional } from '../../src/decorators/injection.ts';
import { metadataStore } from '../../src/metadata/metadata-store.ts';

describe('Optional constructor dependencies', () => {
  beforeEach(() => {
    metadataStore.clear();
  });

  it('records the marked argument indices', () => {
    @Injectable()
    @Inject('required', Optional('maybe'))
    class Target {
      constructor(readonly required: unknown, readonly maybe?: unknown) {}
    }
    expect([...metadataStore.ctorOptional(Target)]).toEqual([1]);
    expect(metadataStore.getService(Target)?.inject).toEqual(['required', 'maybe']);
  });

  it('records several optional arguments independently', () => {
    @Injectable()
    @Inject(Optional('a'), 'b', Optional('c'))
    class Several {
      constructor(readonly a?: unknown, readonly b?: unknown, readonly c?: unknown) {}
    }
    expect([...metadataStore.ctorOptional(Several)].sort()).toEqual([0, 2]);
  });

  it('reports an empty set for a class that marked nothing optional', () => {
    @Injectable()
    @Inject('a')
    class None {
      constructor(readonly a: unknown) {}
    }
    expect([...metadataStore.ctorOptional(None)]).toEqual([]);
  });

  it('reports an empty set for a class with no injection metadata at all', () => {
    class Bare {}
    expect([...metadataStore.ctorOptional(Bare)]).toEqual([]);
  });

  it('clears recorded optional indices with the rest of the store', () => {
    @Injectable()
    @Inject(Optional('maybe'))
    class Target {
      constructor(readonly maybe?: unknown) {}
    }
    expect([...metadataStore.ctorOptional(Target)]).toEqual([0]);
    metadataStore.clear();
    expect([...metadataStore.ctorOptional(Target)]).toEqual([]);
  });

  it('Optional(token) is a plain marker, not a decorator', () => {
    // It is used INSIDE @Inject, in the position of the argument it describes,
    // because the TC39 proposal has no parameter position to apply it to.
    expect(Optional('cache')).toEqual({ token: 'cache', optional: true });
  });
});
