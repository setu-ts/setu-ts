/**
 * Unit tests for validation helper functions.
 *
 * Covers that each helper (validateBody, validateQuery, validateParams,
 * validateHeaders, validateCookies) delegates to the service's middleware
 * method via the correct target by using the real ValidationService.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES } from '@hono-enterprise/common';

import {
  validateBody,
  validateCookies,
  validateHeaders,
  validateParams,
  validateQuery,
} from '../../src/middleware/validation-middleware.ts';
import { ValidationService } from '../../src/services/validation-service.ts';
import { defaultFormatter } from '../../src/formatters/default-formatter.ts';
import { createFakeContext } from '../fixtures/fake-runtime.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SERVICE = new ValidationService(defaultFormatter);

function createFakeSchema() {
  return {
    safeParse(data: unknown) {
      return { success: true as const, data };
    },
  };
}

// ---------------------------------------------------------------------------
// Tests — each helper stores validated:<target> via the real service
// ---------------------------------------------------------------------------

describe('validate helpers — delegate to service middleware', () => {
  it('validateBody stores validated:body in ctx.state', async () => {
    const servicesMap = new Map([[CAPABILITIES.VALIDATION, SERVICE]]);
    const { ctx } = createFakeContext({
      services: servicesMap,
      request: { body: { name: 'Alice' } },
    });
    const schema = createFakeSchema();
    const mw = validateBody(schema);

    await mw(ctx, async () => {});

    expect(ctx.state.has('validated:body')).toBe(true);
  });

  it('validateQuery stores validated:query in ctx.state', async () => {
    const servicesMap = new Map([[CAPABILITIES.VALIDATION, SERVICE]]);
    const { ctx } = createFakeContext({
      services: servicesMap,
      query: { page: '1' },
    });
    const schema = createFakeSchema();
    const mw = validateQuery(schema);

    await mw(ctx, async () => {});

    expect(ctx.state.has('validated:query')).toBe(true);
  });

  it('validateParams stores validated:params in ctx.state', async () => {
    const servicesMap = new Map([[CAPABILITIES.VALIDATION, SERVICE]]);
    const { ctx } = createFakeContext({
      services: servicesMap,
      params: { id: '42' },
    });
    const schema = createFakeSchema();
    const mw = validateParams(schema);

    await mw(ctx, async () => {});

    expect(ctx.state.has('validated:params')).toBe(true);
  });

  it('validateHeaders stores validated:headers in ctx.state', async () => {
    const servicesMap = new Map([[CAPABILITIES.VALIDATION, SERVICE]]);
    const { ctx } = createFakeContext({
      services: servicesMap,
      request: { headers: { 'x-api-key': 'secret' } },
    });
    const schema = createFakeSchema();
    const mw = validateHeaders(schema);

    await mw(ctx, async () => {});

    expect(ctx.state.has('validated:headers')).toBe(true);
  });

  it('validateCookies stores validated:cookies in ctx.state', async () => {
    const servicesMap = new Map([[CAPABILITIES.VALIDATION, SERVICE]]);
    const { ctx } = createFakeContext({
      services: servicesMap,
      request: { headers: { cookie: 'session=abc123' } },
    });
    const schema = createFakeSchema();
    const mw = validateCookies(schema);

    await mw(ctx, async () => {});

    expect(ctx.state.has('validated:cookies')).toBe(true);
  });
});
