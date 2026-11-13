import { beforeEach, describe, expect, it } from 'vitest';
import { CAPABILITIES } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { WebSocketPlugin } from '@setu-ts/websocket-plugin';
import {
  Controller,
  DecoratorPlugin,
  Gateway,
  Get,
  OnOpen,
  OnMessage,
  Roles,
  Permissions,
  Public,
  RequirePolicy,
  ScopedPermissions,
  ScopedRoles,
} from '../../src/index.ts';
import { metadataStore } from '../../src/metadata/metadata-store.ts';

/** A class policy whose only ability a gateway handler might wrongly require. */
class UpdatesPolicy {
  view(): boolean {
    return true;
  }
}

describe('gateway handshake guards', () => {
  beforeEach(() => metadataStore.clear());
  it('refuses before onOpen and connects when the guard accepts', async () => {
    let opened = 0;
    let downstream = 0;
    @Gateway('/ws', {
      guards: [
        (context) => (context.query['allow'] === 'yes' ? true : { status: 403 }),
        () => {
          downstream++;
          return true;
        },
      ],
    })
    class Updates {
      @OnOpen open(): void {
        opened++;
      }
    }
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        WebSocketPlugin({ scalingNotice: false }),
        DecoratorPlugin({ ingress: [Updates] }),
      ],
    });
    await app.start();
    try {
      const websocket = app.services.get(CAPABILITIES.WEBSOCKET);
      const request = (suffix: string) =>
        new Request(`http://localhost/ws${suffix}`, {
          headers: {
            upgrade: 'websocket',
            connection: 'Upgrade',
            'sec-websocket-version': '13',
            'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
          },
        });
      expect(await websocket.routeUpgrade!(request(''))).toEqual({ accept: false, status: 403 });
      expect(opened).toBe(0);
      expect(downstream).toBe(0);
      const accepted = await websocket.routeUpgrade!(request('?allow=yes'));
      expect(accepted?.accept).toBe(true);
      if (accepted?.accept) {
        accepted.sink.onOpen({ readyState: 'open', send: () => {}, close: () => {} });
        expect(opened).toBe(1);
        expect(downstream).toBe(1);
        accepted.sink.onClose({ code: 1000, reason: '' });
      }
    } finally {
      await app.stop();
    }
  });

  it.each([
    'roles',
    'permissions',
    'public',
    'policy',
    'scoped-roles',
    'scoped-permissions',
    'class-roles',
    'class-permissions',
    'class-scoped-roles',
  ] as const)('refuses ignored %s decorators at startup', async (kind) => {
    const authorization =
      kind === 'roles'
        ? Roles('admin')
        : kind === 'permissions'
          ? Permissions('write')
          : kind === 'policy'
            ? RequirePolicy(UpdatesPolicy, 'view')
            : kind === 'scoped-roles'
              ? ScopedRoles(['admin'])
              : kind === 'scoped-permissions'
                ? ScopedPermissions(['write'])
                : Public();
    @Gateway('/ws')
    class Updates {
      @OnMessage
      @authorization
      message(): void {}
    }
    @Gateway('/ws-class')
    @Roles('admin')
    class RoleUpdates {
      @OnOpen open(): void {}
    }
    @Gateway('/ws-permissions')
    @Permissions('write')
    class PermissionUpdates {
      @OnOpen open(): void {}
    }
    @Gateway('/ws-scoped')
    @ScopedRoles(['admin'])
    class ScopedUpdates {
      @OnOpen open(): void {}
    }
    const target =
      kind === 'class-roles'
        ? RoleUpdates
        : kind === 'class-permissions'
          ? PermissionUpdates
          : kind === 'class-scoped-roles'
            ? ScopedUpdates
            : Updates;
    const app = createApplication({
      plugins: [RuntimePlugin(), WebSocketPlugin(), DecoratorPlugin({ ingress: [target] })],
    });
    try {
      await expect(app.start()).rejects.toThrow(
        /@RequirePolicy, @ScopedRoles or @ScopedPermissions on a gateway[\s\S]*@Gateway\(path, \{ guards \}\)/,
      );
    } finally {
      await app.stop();
    }
  });

  it('keeps HTTP authorization on a class whose gateway declares its own guards', async () => {
    @Controller('/mixed')
    @Gateway('/ws-mixed', { guards: [() => ({ status: 401 })] })
    @Roles('admin')
    class Mixed {
      @Get('/report')
      @Permissions('read')
      report(): { readonly ok: boolean } {
        return { ok: true };
      }

      @OnOpen open(): void {}
    }
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        WebSocketPlugin(),
        DecoratorPlugin({ controllers: [Mixed], ingress: [Mixed] }),
      ],
    });
    try {
      await app.start();
    } finally {
      await app.stop();
    }
  });

  it('refuses class-level authorization on a mixed class whose gateway has no guards', async () => {
    @Controller('/mixed-open')
    @Gateway('/ws-mixed-open')
    @Roles('admin')
    class MixedOpen {
      @Get('/report')
      report(): { readonly ok: boolean } {
        return { ok: true };
      }

      @OnOpen open(): void {}
    }
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        WebSocketPlugin(),
        DecoratorPlugin({ controllers: [MixedOpen], ingress: [MixedOpen] }),
      ],
    });
    try {
      await expect(app.start()).rejects.toThrow('on a gateway');
    } finally {
      await app.stop();
    }
  });

  it('still refuses authorization on the WebSocket handler of a mixed class', async () => {
    @Controller('/mixed-ws')
    @Gateway('/ws-mixed-refused')
    class MixedRefused {
      @Get('/report')
      report(): { readonly ok: boolean } {
        return { ok: true };
      }

      @OnOpen
      @Roles('admin')
      open(): void {}
    }
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        WebSocketPlugin(),
        DecoratorPlugin({ controllers: [MixedRefused], ingress: [MixedRefused] }),
      ],
    });
    try {
      await expect(app.start()).rejects.toThrow('on a gateway');
    } finally {
      await app.stop();
    }
  });
});
