import { beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { Controller } from '../../src/decorators/controller.ts';
import { Get } from '../../src/decorators/http.ts';
import { CurrentUser, Permissions, Public, Roles } from '../../src/decorators/security.ts';
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
      me(@CurrentUser() user: unknown) {
        return user;
      }
    }
    const p = metadataStore.getRoutesFor(C)[0].params[0];
    expect(p).toMatchObject({ type: 'custom', customType: 'current-user' });
  });
});
