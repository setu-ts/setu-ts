/**
 * `@Idempotent` with validation and a guard on a REAL kernel — `IdempotencyPlugin`,
 * `DecoratorPlugin` and `ValidationPlugin` together (plan §3.9, §6): an invalid
 * body consumes no key, a guard's refusal consumes no key, and a retry with the
 * SAME key then executes.
 *
 * The store is a recorder, so "consumed no key" is asserted directly on the
 * claim calls rather than inferred from a status.
 *
 * @module
 */
import { beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { HandlerResult, IIdempotencyStore, IRequestContext } from '@setu-ts/common';
import {
  Body,
  Controller,
  DecoratorPlugin,
  Idempotent,
  metadataStore,
  Params,
  Post,
  UseGuards,
  ValidateBody,
} from '@setu-ts/decorator-plugin';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { ValidationPlugin } from '@setu-ts/validation-plugin';
import { IdempotencyPlugin } from '../../src/index.ts';

// Real Zod, guarded the same way the validation suites are: the invalid-body
// case needs a schema that actually rejects, so it is skipped where npm:zod
// cannot load rather than passing vacuously.
const zodModule = await import('npm:zod@^3.24.0').catch(() => undefined);
const z = zodModule?.z;
const itZod = z === undefined ? it.skip : it;

/** A store that records every claim and always grants it. */
function recordingStore() {
  const claims: string[] = [];
  const store: IIdempotencyStore = {
    name: 'recording',
    connect: () => Promise.resolve(),
    claim: (request) => {
      claims.push(request.key);
      return Promise.resolve({ outcome: 'claimed', takeover: false });
    },
    complete: () => Promise.resolve('settled'),
    release: () => Promise.resolve('lost'),
  };
  return { store, claims };
}

/** A guard that refuses with 401 without calling the handler. */
const refusingGuard = (ctx: IRequestContext): HandlerResult => {
  ctx.response.status(401).json({ error: 'unauthorized' });
  return { __handlerResult: true } as HandlerResult;
};

describe('@Idempotent with validation and a guard (M109a §3.9)', () => {
  beforeEach(() => {
    metadataStore.clear();
  });

  itZod('consumes no key for an invalid body, so the corrected retry executes', async () => {
    const { store, claims } = recordingStore();
    const Schema = z!.object({ amount: z!.number() });
    let ran = 0;

    @Controller('/payments')
    class PaymentController {
      @Post('/')
      @ValidateBody(Schema)
      // `optional` because these requests carry no principal: the test is
      // about the validation/guard ORDER, not about the principal check.
      @Idempotent({ principal: 'optional' })
      @Params(Body())
      create(body: { amount: number }) {
        ran++;
        return { amount: body.amount };
      }
    }

    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        ValidationPlugin(),
        IdempotencyPlugin({ store: { type: 'custom', store } }),
        DecoratorPlugin({ controllers: [PaymentController] }),
      ],
    });
    await app.start();
    try {
      const bad = await app.inject({
        method: 'POST',
        url: 'http://localhost/payments',
        headers: { 'Idempotency-Key': 'k-1' },
        body: { amount: 'not-a-number' },
      });
      expect(bad.statusCode).toBe(400);
      // Validation answered first: the idempotency middleware never ran.
      expect(claims).toHaveLength(0);

      const good = await app.inject({
        method: 'POST',
        url: 'http://localhost/payments',
        headers: { 'Idempotency-Key': 'k-1' },
        body: { amount: 5 },
      });
      expect(good.statusCode).toBe(200);
      expect(claims).toHaveLength(1);
      expect(ran).toBe(1);
    } finally {
      await app.stop();
    }
  });

  it('consumes no key when a guard refuses with 401', async () => {
    const { store, claims } = recordingStore();
    let ran = 0;

    @Controller('/secret')
    class SecretController {
      @Post('/')
      @UseGuards(refusingGuard)
      // `optional`, so the 401 in this test can only come from the GUARD —
      // idempotency's own principal check must not answer first.
      @Idempotent({ principal: 'optional' })
      create() {
        ran++;
        return { ok: true };
      }
    }

    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        IdempotencyPlugin({ store: { type: 'custom', store } }),
        DecoratorPlugin({ controllers: [SecretController] }),
      ],
    });
    await app.start();
    try {
      const refused = await app.inject({
        method: 'POST',
        url: 'http://localhost/secret',
        headers: { 'Idempotency-Key': 'k-2' },
        body: '{}',
      });
      expect(refused.statusCode).toBe(401);
      expect(claims).toHaveLength(0);
      expect(ran).toBe(0);
    } finally {
      await app.stop();
    }
  });
});
