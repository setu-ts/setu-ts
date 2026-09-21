/**
 * The M99c V7-6 collision, and the allocation rule that resolves it.
 *
 * A document can legally name a component exactly the way the generator names
 * a hoisted alias: component `GetItemsResponse200` beside an inline
 * multi-line 200 body on `get-items` claimed `GetItemsResponse200` twice and
 * generation aborted with `Duplicate generated name 'GetItemsResponse200'`.
 * Both derivations are individually correct — the interaction is the defect,
 * and the same interaction exists at all four hoist sites (request body,
 * parameter, success response, error body).
 *
 * The rule (M99c §3.1/§3.1a): a hoisted alias names an anonymous inline
 * schema the document never named, so the ALIAS is the side that yields —
 * today's name first, so no document that generates today has any alias
 * renamed; then the response arm's `…Response<status>Body` alternate, which
 * reads correctly beside a component of the same name; then a numeric suffix
 * ALLOCATED through the registry, because `claim` throws and an
 * assumed-free suffix would merely move the abort. Names derived from
 * something the caller WROTE — component schemas, `*Args`, `*Error`, guards,
 * the options — keep the hard throw.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { generateOpenApiClient } from '../../src/codegen/openapi-codegen.ts';
import type { SdkOpenApiDocument, SdkOpenApiSchema } from '../../src/codegen/openapi-types.ts';
import { nameCollisionDocument } from '../fixtures/name-collision-document.ts';

/** Any shape that renders multi-line, forcing a hoist. */
const INLINE_SHAPE: SdkOpenApiSchema = {
  type: 'object',
  properties: { id: { type: 'string' } },
};

/**
 * One document carrying ALL FOUR hoist sites, so each arm's case is measured
 * with the other three arms allocating around it, exactly as a real document
 * would.
 */
function docWith(components: Record<string, SdkOpenApiSchema>): SdkOpenApiDocument {
  return {
    openapi: '3.1.0',
    paths: {
      '/items': {
        get: {
          operationId: 'get-items',
          responses: {
            '200': {
              description: 'ok',
              content: { 'application/json': { schema: INLINE_SHAPE } },
            },
            '400': {
              description: 'bad request',
              content: { 'application/json': { schema: INLINE_SHAPE } },
            },
          },
        },
      },
      '/orders': {
        post: {
          operationId: 'place-order',
          requestBody: {
            content: { 'application/json': { schema: INLINE_SHAPE } },
            required: true,
          },
          responses: { '201': { description: 'created' } },
        },
      },
      '/search': {
        get: {
          operationId: 'run-search',
          parameters: [
            { name: 'filter', in: 'query', schema: INLINE_SHAPE },
          ],
          responses: { '200': { description: 'ok' } },
        },
      },
    },
    components: { schemas: components },
  };
}

/**
 * Each arm's candidate ladder, in allocation order, and the components a case
 * must pre-claim to force each rung. The response arm alone alternates to
 * `…Response<status>Body` before the numerics (§3.1a); the other three go
 * straight from the preferred name to `…2`, `…3`.
 */
const ARMS: {
  readonly arm: string;
  readonly ladder: readonly string[];
  /** Components pre-declared before the arm's own hoist, per rung. */
  readonly claimed: readonly (readonly string[])[];
}[] = [
  {
    arm: 'success response',
    ladder: [
      'GetItemsResponse200',
      'GetItemsResponse200Body',
      'GetItemsResponse200Body2',
      'GetItemsResponse200Body3',
    ],
    claimed: [
      [],
      ['GetItemsResponse200'],
      ['GetItemsResponse200', 'GetItemsResponse200Body'],
      ['GetItemsResponse200', 'GetItemsResponse200Body', 'GetItemsResponse200Body2'],
    ],
  },
  {
    arm: 'request body',
    ladder: ['PlaceOrderBody', 'PlaceOrderBody2', 'PlaceOrderBody3'],
    claimed: [[], ['PlaceOrderBody'], ['PlaceOrderBody', 'PlaceOrderBody2']],
  },
  {
    arm: 'parameter',
    ladder: ['RunSearchFilterParam', 'RunSearchFilterParam2', 'RunSearchFilterParam3'],
    claimed: [[], ['RunSearchFilterParam'], ['RunSearchFilterParam', 'RunSearchFilterParam2']],
  },
  {
    arm: 'error body',
    ladder: ['GetItemsError400Body', 'GetItemsError400Body2', 'GetItemsError400Body3'],
    claimed: [[], ['GetItemsError400Body'], ['GetItemsError400Body', 'GetItemsError400Body2']],
  },
];

describe('a hoisted alias yields to a claimed name instead of aborting (M99c V7-6)', () => {
  for (const spec of ARMS) {
    describe(`${spec.arm} arm`, () => {
      for (const [rung, claimed] of spec.claimed.entries()) {
        it(
          claimed.length === 0
            ? 'keeps the preferred alias when nothing claimed it — no rename'
            : `yields to the claimed names, landing on '${spec.ladder[rung]}'`,
          () => {
            const components = Object.fromEntries(
              claimed.map((name) => [name, INLINE_SHAPE]),
            );
            const out = generateOpenApiClient(docWith(components), {});
            // The chosen rung is emitted as a type…
            expect(out).toContain(`export type ${spec.ladder[rung]} = {`);
            // …and every LATER rung is untouched. (Earlier rungs may appear —
            // a claimed component IS emitted under its own name.)
            for (const later of spec.ladder.slice(rung + 1)) {
              expect(out).not.toContain(later);
            }
          },
        );
      }

      it('emits BOTH the component and its alias — a duplicate, not a dedupe (§3.2)', () => {
        const out = generateOpenApiClient(docWith({ [spec.ladder[0]]: INLINE_SHAPE }), {});
        // The component keeps its own name and its own emitted shape, and the
        // alias carries a structurally identical copy under the arm's
        // candidate name. A later structural dedupe must be a conscious
        // change, and this assertion is what makes it one.
        expect(out).toContain(`export type ${spec.ladder[0]} = {`);
        expect(out).toContain(`export type ${spec.ladder[1]} = {`);
      });
    });
  }

  it('the response arm alternates to …Response<status>Body, not the numeric form', () => {
    // The asymmetry is deliberate (§3.1a): `GetItemsResponse200Body` reads
    // beside a component of the same name, while `GetItemsResponse2002` reads
    // as a status code.
    const out = generateOpenApiClient(docWith({ GetItemsResponse200: INLINE_SHAPE }), {});
    expect(out).toContain('export type GetItemsResponse200Body = {');
    expect(out).not.toContain('GetItemsResponse2002');
  });

  it('the request-body arm goes straight to the numeric form — no …BodyBody', () => {
    const out = generateOpenApiClient(docWith({ PlaceOrderBody: INLINE_SHAPE }), {});
    expect(out).toContain('export type PlaceOrderBody2 = {');
    expect(out).not.toContain('PlaceOrderBodyBody');
  });

  it('a $ref body still generates — the control that passed before the fix', () => {
    const doc: SdkOpenApiDocument = {
      openapi: '3.1.0',
      paths: {
        '/orders': {
          post: {
            operationId: 'place-order',
            requestBody: {
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Order' } } },
              required: true,
            },
            responses: { '200': { description: 'ok' } },
          },
        },
      },
      components: {
        schemas: { Order: { type: 'object', properties: { id: { type: 'string' } } } },
      },
    };
    const out = generateOpenApiClient(doc, {});
    expect(out).toContain('export type Order = {');
    expect(out).toContain('body: Order;');
  });

  it('emits the committed name-collision fixture byte-for-byte', () => {
    const generated = generateOpenApiClient(nameCollisionDocument, {
      sdkImport: '../../src/index.ts',
    });
    const fixture = Deno.readTextFileSync(
      new URL('../fixtures/name-collision-client.ts', import.meta.url),
    );
    expect(generated).toBe(fixture);
  });
});
