/**
 * `requirePolicy` is documented by the REAL `OpenApiPlugin`'s
 * `deriveSecurity` (M110a §3.10): an ability that requires a signed-in
 * principal is documented as requiring the scheme, and an ability that opted
 * in to anonymous principals is documented as public — it must not claim a
 * requirement the guard does not enforce.
 *
 * @module
 */
import { afterEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createApplication } from '@setu-ts/kernel';
import type { IKernelApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { OpenApiPlugin } from '@setu-ts/openapi-plugin';

import { AuthPlugin, definePolicy, requirePolicy } from '../../src/index.ts';

const docPolicy = definePolicy({
  name: 'doc',
  abilities: { edit: () => true, view: { anonymous: true, check: () => true } },
});

let app: IKernelApplication | undefined;

afterEach(async () => {
  await app?.stop();
  app = undefined;
});

describe('requirePolicy in the derived OpenAPI document', () => {
  it('documents an authenticated ability as secured and an anonymous one as public', async () => {
    const built = createApplication({
      plugins: [
        RuntimePlugin(),
        AuthPlugin({ jwt: { secret: 'x'.repeat(40) }, policies: [docPolicy] }),
        OpenApiPlugin({
          title: 'Policies',
          version: '1.0.0',
          securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
          deriveSecurity: { scheme: 'bearerAuth' },
        }),
      ],
    });
    built.router.patch('/docs/:id', {
      middleware: [requirePolicy(docPolicy, 'edit')],
      handler: (ctx) => ctx.response.json({}),
    });
    built.router.get('/docs/:id', {
      middleware: [requirePolicy(docPolicy, 'view')],
      handler: (ctx) => ctx.response.json({}),
    });
    await built.start();
    app = built;

    const response = await built.inject({ method: 'GET', url: 'http://localhost/openapi.json' });
    const spec = response.json() as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
    };
    expect(spec.paths['/docs/{id}']?.patch?.security).toEqual([{ bearerAuth: [] }]);
    expect(spec.paths['/docs/{id}']?.get?.security).toEqual([]);
  });
});
