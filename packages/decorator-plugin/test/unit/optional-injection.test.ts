/**
 * Unit tests for the `@Optional` constructor-parameter decorator and the
 * metadata it writes.
 *
 * The resolution behaviour it drives lives in `DecoratorPlugin` and is covered
 * in `test/integration/di-interop.test.ts` against the REAL container and the
 * REAL service registry — the recording fake in `decorator-plugin.test.ts`
 * builds every provider with `new useClass()` and so cannot honor a
 * `useFactory`, which is the form an `@Optional` class registers.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { Inject, Injectable, Optional } from '../../src/index.ts';
import { metadataStore } from '../../src/metadata/metadata-store.ts';

describe('@Optional decorator', () => {
  it('records the decorated constructor argument indices', () => {
    metadataStore.clear();

    @Injectable()
    class Target {
      constructor(
        @Inject('required') readonly a: object,
        @Optional() @Inject('maybe') readonly b?: object,
      ) {}
    }

    expect([...metadataStore.ctorOptional(Target)]).toEqual([1]);
    expect(metadataStore.ctorInject(Target)).toEqual(['required', 'maybe']);
  });

  it('is order-independent with @Inject on the same parameter', () => {
    metadataStore.clear();

    @Injectable()
    class InjectFirst {
      constructor(@Inject('maybe') @Optional() readonly a?: object) {}
    }

    @Injectable()
    class OptionalFirst {
      constructor(@Optional() @Inject('maybe') readonly a?: object) {}
    }

    expect([...metadataStore.ctorOptional(InjectFirst)]).toEqual([0]);
    expect([...metadataStore.ctorOptional(OptionalFirst)]).toEqual([0]);
  });

  it('records several optional arguments independently', () => {
    metadataStore.clear();

    @Injectable()
    class Target {
      constructor(
        @Optional() @Inject('a') readonly a?: object,
        @Inject('b') readonly b?: object,
        @Optional() @Inject('c') readonly c?: object,
      ) {}
    }

    expect([...metadataStore.ctorOptional(Target)].sort()).toEqual([0, 2]);
  });

  it('reports an empty set for a class that marked nothing optional', () => {
    metadataStore.clear();

    class Plain {}

    expect(metadataStore.ctorOptional(Plain).size).toBe(0);
  });

  it('clears recorded optional indices with the rest of the store', () => {
    metadataStore.clear();

    @Injectable()
    class Target {
      constructor(@Optional() @Inject('maybe') readonly a?: object) {}
    }

    expect(metadataStore.ctorOptional(Target).size).toBe(1);
    metadataStore.clear();
    expect(metadataStore.ctorOptional(Target).size).toBe(0);
  });

  it('throws when applied to a method parameter', () => {
    metadataStore.clear();

    expect(() => {
      class Target {
        handle(@Optional() _value: string): void {}
      }
      return Target;
    }).toThrow(/only valid on a constructor parameter/);
  });
});
