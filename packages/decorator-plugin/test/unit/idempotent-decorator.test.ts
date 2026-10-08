/**
 * `@Idempotent` metadata recording (M109a §3.9).
 *
 * @module
 */
import { beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { Controller } from '../../src/decorators/controller.ts';
import { Idempotent } from '../../src/decorators/idempotency.ts';
import { Get, Post } from '../../src/decorators/http.ts';
import { metadataStore } from '../../src/metadata/metadata-store.ts';

describe('@Idempotent metadata (M109a §3.9)', () => {
  beforeEach(() => {
    metadataStore.clear();
  });

  it('records the options on the route', () => {
    @Controller('/payments')
    class C {
      @Post('/')
      @Idempotent({ namespace: 'ns', leaseMs: 1_000 })
      create() {
        return {};
      }
    }
    expect(metadataStore.getRoutesFor(C)[0].idempotent).toEqual({
      namespace: 'ns',
      leaseMs: 1_000,
    });
  });

  it('records an empty object when no options are given', () => {
    @Controller('/p')
    class C {
      @Post('/')
      @Idempotent()
      create() {
        return {};
      }
    }
    expect(metadataStore.getRoutesFor(C)[0].idempotent).toEqual({});
  });

  it('lets the topmost decorator win', () => {
    @Controller('/p')
    class C {
      @Post('/')
      @Idempotent({ namespace: 'top' })
      @Idempotent({ namespace: 'bottom' })
      create() {
        return {};
      }
    }
    expect(metadataStore.getRoutesFor(C)[0].idempotent).toEqual({ namespace: 'top' });
  });

  it('leaves the field absent on an undecorated route', () => {
    @Controller('/p')
    class C {
      @Get('/')
      list() {
        return [];
      }
    }
    expect(metadataStore.getRoutesFor(C)[0].idempotent).toBeUndefined();
  });
});
