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
