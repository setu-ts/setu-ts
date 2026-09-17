/**
 * The register-time refusals for the response-shaping decorators
 * (M97b §3.3a, §3.3b, §3.3c).
 *
 * Every value these check is a compile-time literal known when the route is
 * registered, so the alternative to refusing is a per-request failure that
 * nothing can answer: a status outside `[200, 599]` throws `RangeError` inside
 * the adapter AFTER the pipeline has finished, and an invalid header pair
 * throws `TypeError` inside the handler wrapper, answering `500` on every
 * request to the route.
 *
 * Driven through `validateResponseShaping` — the one entry point
 * `registerController` calls — and, for the two headline cases, through a REAL
 * kernel application, so the refusal is proven to reach `register()` rather
 * than merely existing.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createTestApp } from '@setu-ts/testing';
import { RuntimePlugin } from '@setu-ts/runtime';
import type { Constructor } from '@setu-ts/common';

import { validateResponseShaping } from '../../src/decorators/response-status.ts';
import { Controller, DecoratorPlugin, Get, HttpCode, Redirect } from '../../src/index.ts';

const WHERE = 'Route POST /orders (OrderController.create)';

/** Runs the validator and returns the message it refused with, or `null`. */
function refusal(declared: Parameters<typeof validateResponseShaping>[0]): string | null {
  try {
    validateResponseShaping(declared, WHERE);
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

describe('@HttpCode status validation', () => {
  it('refuses every unserveable status, naming the value', () => {
    // `4004` is the plausible typo `error-responder.ts` names for this class;
    // `2.5` and `NaN` are the two non-integers the web Response constructor
    // silently truncates to something else rather than reporting.
    for (const status of [0, 99, 199, 600, 1000, 2.5, Number.NaN, 4004, -1]) {
      const message = refusal({ httpCode: status });

      expect(message).toContain(`@HttpCode(${status})`);
      expect(message).toContain('not a serveable HTTP status');
      expect(message).toContain(WHERE);
    }
  });

  it('accepts both ends of the serveable range', () => {
    expect(refusal({ httpCode: 200 })).toBeNull();
    expect(refusal({ httpCode: 599 })).toBeNull();
  });

  it('accepts a non-2xx status — the error path is not monopolised', () => {
    // Deliberately NOT narrowed to 2xx: a handler answering 404 through a
    // decorator is legitimate.
    expect(refusal({ httpCode: 404 })).toBeNull();
    expect(validateResponseShaping({ httpCode: 404 }, WHERE)).toEqual({
      status: 404,
      headers: [],
    });
  });

  it('refuses from a REAL application register(), not only in isolation', async () => {
    @Controller('/bad')
    class BadStatusController {
      @HttpCode(4004)
      @Get('/')
      handle(): number {
        return 1;
      }
    }

    await expect(
      createTestApp({
        plugins: [
          RuntimePlugin(),
          DecoratorPlugin({ controllers: [BadStatusController as Constructor] }),
        ],
      }),
    ).rejects.toThrow('not a serveable HTTP status');
  });
});

describe('@Redirect status validation', () => {
  it('refuses a non-3xx status, naming the url and the value', () => {
    for (const status of [200, 201, 299, 400, 404, 500, 3.5, Number.NaN]) {
      const message = refusal({ redirect: { url: '/x', status } });

      expect(message).toContain(`@Redirect('/x', ${status})`);
      expect(message).toContain('not a redirect status');
    }
  });

  it('accepts the redirect statuses and both ends of the range', () => {
    for (const status of [300, 301, 302, 303, 307, 308, 399]) {
      expect(refusal({ redirect: { url: '/x', status } })).toBeNull();
    }
  });

  it('collapses a redirect into the status it sets and the Location it writes', () => {
    expect(validateResponseShaping({ redirect: { url: '/v2', status: 301 } }, WHERE)).toEqual({
      status: 301,
      location: '/v2',
      headers: [],
    });
  });

  it('refuses from a REAL application register()', async () => {
    @Controller('/bad')
    class BadRedirectController {
      @Redirect('/x', 200)
      @Get('/')
      handle(): number {
        return 1;
      }
    }

    await expect(
      createTestApp({
        plugins: [
          RuntimePlugin(),
          DecoratorPlugin({ controllers: [BadRedirectController as Constructor] }),
        ],
      }),
    ).rejects.toThrow('not a redirect status');
  });
});

describe('two declarations of one status', () => {
  it('refuses @HttpCode alongside @Redirect, naming both', () => {
    const message = refusal({ httpCode: 201, redirect: { url: '/x', status: 302 } });

    expect(message).toContain('@HttpCode(201)');
    expect(message).toContain("@Redirect('/x', 302)");
    expect(message).toContain('Both set the response status');
  });
});

describe('@ResponseHeader validation', () => {
  it('refuses a header name the runtime rejects, quoting its own message', () => {
    const message = refusal({ responseHeaders: [{ name: 'x custom', value: 'v' }] });

    expect(message).toContain("@ResponseHeader('x custom', 'v')");
    expect(message).toContain('Invalid header name');
  });

  it('refuses a header value the runtime rejects', () => {
    const value = `bad${String.fromCharCode(10)}value`;
    const message = refusal({ responseHeaders: [{ name: 'X-Custom', value }] });

    expect(message).toContain('Invalid header value');
  });

  it('refuses an empty header name', () => {
    expect(refusal({ responseHeaders: [{ name: '', value: 'v' }] }))
      .toContain('Invalid header name');
  });

  it('accepts what the runtime accepts, including an empty value', () => {
    // Measured rather than assumed: `Headers.set('X-Custom', '')` succeeds, and
    // so does a value with leading whitespace (which the runtime trims). Both
    // are therefore NOT refused.
    expect(refusal({ responseHeaders: [{ name: 'X-Custom', value: '' }] })).toBeNull();
    expect(refusal({ responseHeaders: [{ name: 'X-Custom', value: '  lead' }] })).toBeNull();
    expect(refusal({ responseHeaders: [{ name: 'Set-Cookie', value: 'a=1' }] })).toBeNull();
  });

  it('refuses the same name twice, case-insensitively', () => {
    const message = refusal({
      responseHeaders: [{ name: 'X-A', value: '1' }, { name: 'x-a', value: '2' }],
    });

    expect(message).toContain('twice');
    expect(message).toContain('case-insensitive');
    expect(message).toContain('appendHeader');
  });

  it('accepts distinct names', () => {
    expect(
      refusal({
        responseHeaders: [
          { name: 'Cache-Control', value: 'no-store' },
          { name: 'X-Report-Version', value: '3' },
        ],
      }),
    ).toBeNull();
  });

  it('refuses a declared Location alongside @Redirect, which writes it too', () => {
    const message = refusal({
      redirect: { url: '/x', status: 302 },
      responseHeaders: [{ name: 'Location', value: '/y' }],
    });

    expect(message).toContain("@ResponseHeader('Location', '/y')");
    expect(message).toContain("@Redirect('/x', 302)");
  });

  it('allows a Location header when there is no @Redirect', () => {
    expect(refusal({ responseHeaders: [{ name: 'Location', value: '/y' }] })).toBeNull();
  });
});

describe('a route that declared nothing', () => {
  it('yields no shaping at all, so the handler wrapper is unchanged', () => {
    expect(validateResponseShaping({}, WHERE)).toBeUndefined();
    expect(validateResponseShaping({ responseHeaders: [] }, WHERE)).toBeUndefined();
  });
});
