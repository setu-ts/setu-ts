import { beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { Controller } from '../../src/decorators/controller.ts';
import { Get } from '../../src/decorators/http.ts';
import {
  CONTEXT_PARAMETER_METADATA,
  Permissions,
  Public,
  Roles,
} from '../../src/decorators/security.ts';
import { Body, Ctx, CurrentUser, Params } from '../../src/decorators/params.ts';
import { metadataStore } from '../../src/metadata/metadata-store.ts';

describe('Security decorators', () => {
  beforeEach(() => {
    metadataStore.clear();
  });

  it('@Roles at method level stores roles on the route', () => {
    @Controller('/x')
    class C {
      @Get('/')
      @Roles('admin')
      list() {
        return [];
      }
    }
    expect(metadataStore.getRoutesFor(C)[0].roles).toEqual(['admin']);
  });

  it('@Roles at class level stores default roles on the controller', () => {
    @Controller('/x')
    @Roles('admin', 'staff')
    class C {
      @Get('/')
      list() {
        return [];
      }
    }
    expect(metadataStore.getController(C)?.roles).toEqual(['admin', 'staff']);
  });

  it('@Permissions stores permissions on the route', () => {
    @Controller('/x')
    class C {
      @Get('/')
      @Permissions('read', 'write')
      list() {
        return [];
      }
    }
    expect(metadataStore.getRoutesFor(C)[0].permissions).toEqual(['read', 'write']);
  });

  it('refuses empty @Roles and @Permissions declarations', () => {
    expect(() => Roles()).toThrow('@Roles() requires at least one role.');
    expect(() => Permissions()).toThrow('@Permissions() requires at least one permission.');
  });

  it('@Public sets isPublic on the route', () => {
    @Controller('/x')
    class C {
      @Get('/')
      @Public()
      list() {
        return [];
      }
    }
    expect(metadataStore.getRoutesFor(C)[0].isPublic).toBe(true);
  });

  it('@Public and @Roles both stored (Public precedence is enforced elsewhere)', () => {
    @Controller('/x')
    class C {
      @Get('/')
      @Public()
      @Roles('admin')
      list() {
        return [];
      }
    }
    const r = metadataStore.getRoutesFor(C)[0];
    expect(r.isPublic).toBe(true);
    expect(r.roles).toEqual(['admin']);
  });

  it('@CurrentUser stores a custom current-user parameter', () => {
    @Controller('/x')
    class C {
      @Get('/me')
      @Params(CurrentUser())
      me(user: unknown) {
        return user;
      }
    }
    const p = metadataStore.getRoutesFor(C)[0].params[0];
    expect(p).toMatchObject({ type: 'custom', customType: 'current-user' });
  });

  it('Ctx() stores a custom context parameter at its declared index', () => {
    @Controller('/x')
    class C {
      @Get('/create')
      // Positional binding is explicit: to reach argument 1, argument 0 must
      // name a source too. The legacy form inferred the index from where the
      // decorator sat, which is exactly the information a parameter position
      // no longer carries.
      @Params(Body(), Ctx())
      create(_ignored: unknown, ctx: unknown) {
        return ctx;
      }
    }
    const params = metadataStore.getRoutesFor(C)[0].params;
    const p = params[1];
    expect(params[0]).toMatchObject({ index: 0, type: 'body' });
    expect(p).toMatchObject({ index: 1, type: 'custom', customType: 'context' });
    expect(p.metadata).toBe(CONTEXT_PARAMETER_METADATA);
  });

  it('@Permissions at class level stores default permissions', () => {
    @Controller('/x')
    @Permissions('read')
    class C {
      @Get('/')
      list() {
        return [];
      }
    }
    expect(metadataStore.getController(C)?.permissions).toEqual(['read']);
  });

  it('@Permissions at method level stores permissions on the route', () => {
    @Controller('/x')
    class C {
      @Get('/')
      @Permissions('admin:delete')
      list() {
        return [];
      }
    }
    expect(metadataStore.getRoutesFor(C)[0].permissions).toEqual(['admin:delete']);
  });
});
