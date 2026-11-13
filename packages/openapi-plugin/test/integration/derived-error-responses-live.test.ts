/**
 * The M137b gate, live: the same table the unit test runs against the
 * generator, run against a running application. For every row, every status
 * the served document lists is triggered and must actually occur with every
 * header the document lists for it — so the document cannot claim a response
 * the route never sends.
 *
 * @module
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApplication } from '@setu-ts/kernel';
import type { InjectResponse } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { CAPABILITIES } from '@setu-ts/common';
import type { IJwtService } from '@setu-ts/common';
import { AuthPlugin } from '@setu-ts/auth-plugin';
import { ValidationPlugin } from '@setu-ts/validation-plugin';
import { IdempotencyPlugin } from '@setu-ts/idempotency-plugin';
import { errorHandler } from '@setu-ts/exceptions';

import { OpenApiPlugin } from '../../src/plugin/openapi-plugin.ts';
import type { OpenApiDocument, OpenApiOperation } from '../../src/index.ts';
import { BEARER_SCHEMES, ERROR_RESPONSE_TABLE } from '../fixtures/error-response-table.ts';
import type { LiveRequest, LiveTrigger } from '../fixtures/error-response-table.ts';

type App = ReturnType<typeof createApplication>;

let app: App;
let spec: OpenApiDocument;

/** Set only while a concurrent trigger runs; POST handlers wait on it. */
let hold: Promise<void> | undefined;

beforeAll(async () => {
  app = createApplication({
    plugins: [
      RuntimePlugin(),
      AuthPlugin({
        jwt: { secret: 'm137b-live-secret-at-least-32-characters' },
        rbac: { roles: {} },
      }),
      ValidationPlugin({ errorFormat: 'rfc9457' }),
      // One entry per caller scope, so a second distinct key answers the
      // capacity `429`; every idempotency trigger uses its own principal.
      IdempotencyPlugin({ store: { type: 'memory', maxEntriesPerScope: 1 } }),
      OpenApiPlugin({
        title: 'Live',
        version: '1',
        swagger: false,
        securitySchemes: BEARER_SCHEMES,
        deriveSecurity: { scheme: 'bearerAuth' },
        errorSchema: 'rfc9457',
      }),
    ],
  });
  app.middleware.add(errorHandler({ format: 'rfc9457' }), { priority: 0, name: 'error-handler' });
  ERROR_RESPONSE_TABLE.forEach((row, index) => {
    const register = row.method === 'GET' ? app.router.get : app.router.post;
    register.call(app.router, `/r${index}`, {
      middleware: row.middleware(),
      handler: async (ctx) => {
        // A concurrent trigger holds whichever request claimed the key until
        // the other has answered, so the duplicate always finds the claim in
        // progress rather than racing the first handler to completion.
        if (hold !== undefined) await hold;
        return ctx.response.json({ ok: true });
      },
    });
  });
  await app.start();
  spec = (await app.inject({ method: 'GET', url: 'http://localhost/openapi.json' })).json();
});

afterAll(async () => {
  await app.stop();
});

async function send(index: number, method: string, request: LiveRequest): Promise<InjectResponse> {
  const headers: Record<string, string> = { ...request.headers };
  if (request.as !== undefined) {
    const jwt = app.services.get<IJwtService>(CAPABILITIES.JWT);
    headers['authorization'] = `Bearer ${await jwt.sign({ ...request.as })}`;
  }
  return app.inject({
    method,
    url: `http://localhost/r${index}`,
    headers,
    ...(request.body !== undefined ? { body: request.body } : {}),
  });
}

async function fire(
  index: number,
  method: string,
  trigger: LiveTrigger,
): Promise<InjectResponse[]> {
  if (trigger.concurrent === true) {
    let release!: () => void;
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sent = trigger.requests.map((request) => send(index, method, request));
    try {
      // The first to answer is the refused duplicate; the claimant is held.
      // The timer bounds a regression in which no request is refused.
      await Promise.race([...sent, new Promise((resolve) => setTimeout(resolve, 2_000))]);
    } finally {
      hold = undefined;
      release();
    }
    return Promise.all(sent);
  }
  const responses: InjectResponse[] = [];
  for (const request of trigger.requests) responses.push(await send(index, method, request));
  return [responses[responses.length - 1] as InjectResponse];
}

describe('the M137b table against a live application', () => {
  ERROR_RESPONSE_TABLE.forEach((row, index) => {
    it(row.name, async () => {
      const op = (spec.paths[`/r${index}`] as Record<string, OpenApiOperation>)[
        row.method.toLowerCase()
      ] as OpenApiOperation;
      // The served document carries exactly the row's statuses.
      const documented = Object.keys(op.responses).filter((status) => !/^2/.test(status));
      expect(documented).toEqual(Object.keys(row.errors));

      const success = row.live['2xx'];
      if (row.successHeaders.length > 0 || row.absent !== undefined) {
        expect(success, `row "${row.name}" needs a 2xx trigger`).toBeDefined();
      }
      if (success !== undefined) {
        const [response] = await fire(index, row.method, success);
        expect(response?.statusCode).toBe(200);
        for (const header of Object.keys(op.responses['200']?.headers ?? {})) {
          expect(response?.headers.has(header), `200 lacks ${header}`).toBe(true);
        }
        for (const header of row.absent ?? []) expect(response?.headers.has(header)).toBe(false);
      }

      for (const status of documented) {
        if (row.liveSkip?.[status] !== undefined) continue;
        const trigger = row.live[status];
        expect(trigger, `row "${row.name}" has no live trigger for ${status}`).toBeDefined();
        const responses = await fire(index, row.method, trigger as LiveTrigger);
        const hit = responses.find((r) => r.statusCode === Number(status));
        expect(
          hit,
          `"${row.name}" never answered ${status} (got ${responses.map((r) => r.statusCode)})`,
        ).toBeDefined();
        for (const header of Object.keys(op.responses[status]?.headers ?? {})) {
          expect(hit?.headers.has(header), `${status} lacks ${header}`).toBe(true);
        }
        for (const header of row.absent ?? []) expect(hit?.headers.has(header)).toBe(false);
        // errorSchema: every generated error answers in the documented media type.
        expect(op.responses[status]?.content?.['application/problem+json']).toBeDefined();
        expect(hit?.headers.get('content-type')).toContain('application/problem+json');
      }
    });
  });
});
