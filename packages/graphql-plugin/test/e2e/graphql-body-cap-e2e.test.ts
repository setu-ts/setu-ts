/**
 * V5-1 end to end — an oversized GraphQL body is answered `413`, not
 * `400 INVALID_JSON`.
 *
 * Driven through `app.fetch` and NOT `app.inject`, and that is load-bearing
 * rather than stylistic: the cap lives in the HTTP adapter's request mapping
 * (`mapWebRequestToFrameworkRequest`), which `inject` does not go through —
 * it builds its own `IRequest`. An `inject`-based test would pass whatever
 * the handler did, because the body would never be capped in the first place.
 *
 * @module
 */
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { GraphqlPlugin } from '../../src/index.ts';
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

const typeDefs = `
  type Query {
    echo(text: String): String
  }
`;

const resolvers = {
  Query: { echo: (_: unknown, args: { text?: string }) => args.text ?? '' },
};

/** A cap small enough that one query argument can exceed it. */
const MAX_BODY_BYTES = 512;

interface GraphqlBody {
  readonly data?: Record<string, unknown>;
  readonly errors?: ReadonlyArray<{ message: string; extensions?: { code?: string } }>;
}

async function withApp(
  run: (app: ReturnType<typeof createApplication>) => Promise<void>,
): Promise<void> {
  const app = createApplication({
    plugins: [
      RuntimePlugin({ maxBodyBytes: MAX_BODY_BYTES }),
      GraphqlPlugin({ typeDefs, resolvers }),
    ],
  });
  await app.start({ port: 0 });
  try {
    await run(app);
  } finally {
    await app.stop();
  }
}

function post(body: string): Request {
  return new Request('http://localhost/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
}

describe('GraphQL body cap E2E (V5-1)', () => {
  it('answers 413 with the size code for a body past the cap', async () => {
    await withApp(async (app) => {
      const oversized = JSON.stringify({
        query: 'query ($t: String) { echo(text: $t) }',
        variables: { t: 'x'.repeat(MAX_BODY_BYTES * 2) },
      });
      expect(oversized.length).toBeGreaterThan(MAX_BODY_BYTES);

      const res = await app.fetch(post(oversized));
      const json = await res.json() as GraphqlBody;

      // Pre-fix this was 400 / INVALID_JSON.
      expect(res.status).toBe(413);
      expect(json.errors?.[0]?.extensions?.code).toBe('REQUEST_BODY_TOO_LARGE');
      // The disclosure names the configured limit and the option that sets it.
      expect(json.errors?.[0]?.message).toContain(String(MAX_BODY_BYTES));
      expect(json.errors?.[0]?.message).not.toContain('Invalid JSON');
    });
  });

  it('still answers 400 INVALID_JSON for a body under the cap that is not JSON', async () => {
    // The discriminating half: the refusal path must not swallow the parse
    // path, or the fix would trade one wrong status for another.
    await withApp(async (app) => {
      const res = await app.fetch(post('{ this is not json'));
      const json = await res.json() as GraphqlBody;

      expect(res.status).toBe(400);
      expect(json.errors?.[0]?.extensions?.code).toBe('INVALID_JSON');
    });
  });

  it('still serves a valid query under the cap', async () => {
    // Vacuity guard: without this, a handler that refused everything would
    // satisfy the assertion above.
    await withApp(async (app) => {
      const res = await app.fetch(post(JSON.stringify({ query: '{ echo(text: "hi") }' })));
      const json = await res.json() as GraphqlBody;

      expect(res.status).toBe(200);
      expect(json.data?.echo).toBe('hi');
    });
  });
});
