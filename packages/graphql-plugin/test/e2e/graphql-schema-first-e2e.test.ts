/**
 * E2E tests for the schema-first arm, driven through a real kernel application.
 *
 * The point of this file is that the arm is not a stub: an SDL + resolver-map
 * application serves nested queries with arguments and an interface field, a
 * mutation's effect is read back by a following query, and the transport rules
 * that a real client depends on (`Allow` on a 405, a `200` for an executed
 * operation whose data is null) are asserted at the wire.
 */

import { createApplication } from '@hono-enterprise/kernel';
import { RuntimePlugin } from '@hono-enterprise/runtime';
import { GraphqlPlugin } from '../../src/index.ts';
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

interface Note {
  id: string;
  title: string;
  authorId: string;
}

const typeDefs = `
  interface Actor { id: ID!, displayName: String! }

  type User implements Actor {
    id: ID!
    displayName: String!
    email: String!
    notes(limit: Int): [Note!]!
  }

  type Bot implements Actor {
    id: ID!
    displayName: String!
    vendor: String!
  }

  type Note { id: ID!, title: String!, author: User! }

  type Query {
    user(id: ID!): User
    actors: [Actor!]!
    mustExist: String!
  }

  type Mutation {
    addNote(authorId: ID!, title: String!): Note!
  }
`;

/** Build a fresh app with its own mutable store, so cases cannot bleed. */
function createApp() {
  const users: Record<string, { id: string; displayName: string; email: string }> = {
    u1: { id: 'u1', displayName: 'Ada', email: 'ada@example.com' },
  };
  const notes: Note[] = [{ id: 'n1', title: 'first', authorId: 'u1' }];
  let nextId = 2;

  // `FieldResolver` types `args` as `Record<string, unknown>`, so each resolver
  // narrows what it needs rather than declaring a narrower parameter.
  const resolvers = {
    Query: {
      user: (_s: unknown, args: Record<string, unknown>) => users[args.id as string] ?? null,
      actors: () => [
        { __kind: 'User', ...users['u1'] },
        { __kind: 'Bot', id: 'b1', displayName: 'Helper', vendor: 'acme' },
      ],
      // Declared non-null, so a throw here nulls `data` entirely while the
      // operation itself still executed.
      mustExist: () => {
        throw new Error('resolver exploded');
      },
    },
    Mutation: {
      addNote: (_s: unknown, args: Record<string, unknown>) => {
        const note: Note = {
          id: `n${nextId++}`,
          title: args.title as string,
          authorId: args.authorId as string,
        };
        notes.push(note);
        return note;
      },
    },
    User: {
      notes: (parent: unknown, args: Record<string, unknown>) => {
        const mine = notes.filter((n) => n.authorId === (parent as { id: string }).id);
        const limit = args.limit as number | undefined;
        return limit === undefined ? mine : mine.slice(0, limit);
      },
    },
    Note: {
      author: (parent: unknown) => users[(parent as Note).authorId],
    },
    Actor: {
      __resolveType: ((value: unknown) => (value as { __kind?: string }).__kind ?? 'User') as never,
    },
  };

  const app = createApplication({
    plugins: [RuntimePlugin(), GraphqlPlugin({ typeDefs, resolvers })],
  });
  return app;
}

const post = (
  app: ReturnType<typeof createApp>,
  body: unknown,
  accept = 'application/json',
) =>
  app.inject({
    method: 'POST',
    url: '/graphql',
    headers: { 'content-type': 'application/json', accept },
    body: JSON.stringify(body),
  });

describe('GraphQL schema-first E2E', () => {
  it('serves a nested query with arguments through the resolver map', async () => {
    const app = createApp();
    await app.start();

    const res = await post(app, {
      query: `
        query GetUser($id: ID!, $limit: Int) {
          user(id: $id) {
            displayName
            email
            notes(limit: $limit) { title author { displayName } }
          }
        }
      `,
      variables: { id: 'u1', limit: 1 },
      operationName: 'GetUser',
    });

    expect(res.statusCode).toBe(200);
    expect(await res.json()).toEqual({
      data: {
        user: {
          displayName: 'Ada',
          email: 'ada@example.com',
          notes: [{ title: 'first', author: { displayName: 'Ada' } }],
        },
      },
    });

    await app.stop();
  });

  it('drives an interface field through __resolveType', async () => {
    const app = createApp();
    await app.start();

    const res = await post(app, {
      query: '{ actors { displayName ... on User { email } ... on Bot { vendor } } }',
    });

    expect(res.statusCode).toBe(200);
    expect(await res.json()).toEqual({
      data: {
        actors: [
          { displayName: 'Ada', email: 'ada@example.com' },
          { displayName: 'Helper', vendor: 'acme' },
        ],
      },
    });

    await app.stop();
  });

  it('observes a mutation write through a following query', async () => {
    const app = createApp();
    await app.start();

    const written = await post(app, {
      query: 'mutation { addNote(authorId: "u1", title: "second") { id title } }',
    });
    expect(written.statusCode).toBe(200);
    const writeBody = await written.json() as { data: { addNote: { id: string; title: string } } };
    expect(writeBody.data.addNote.title).toBe('second');

    // Read it back through the ordinary query path.
    const readBack = await post(app, {
      query: '{ user(id: "u1") { notes { id title } } }',
    });
    const readBody = await readBack.json() as {
      data: { user: { notes: Array<{ id: string; title: string }> } };
    };
    expect(readBody.data.user.notes.map((n) => n.title)).toEqual(['first', 'second']);
    expect(readBody.data.user.notes[1]?.id).toBe(writeBody.data.addNote.id);

    await app.stop();
  });

  it('answers 405 with Allow: POST for a mutation over GET', async () => {
    const app = createApp();
    await app.start();

    const res = await app.fetch(
      new Request(
        'http://localhost/graphql?query=' +
          encodeURIComponent('mutation { addNote(authorId: "u1", title: "x") { id } }'),
        { headers: { accept: 'application/graphql-response+json' } },
      ),
    );

    expect(res.status).toBe(405);
    // A 405 must advertise what is allowed; a client cannot retry correctly
    // without it.
    expect(res.headers.get('allow')).toBe('POST');
    const body = await res.json() as { errors: Array<{ extensions?: { code?: string } }> };
    expect(body.errors[0]?.extensions?.code).toBe('METHOD_NOT_ALLOWED');

    await app.stop();
  });

  it('keeps a 405 and its Allow header under the application/json watershed', async () => {
    const app = createApp();
    await app.start();

    const res = await app.fetch(
      new Request(
        'http://localhost/graphql?query=' +
          encodeURIComponent('mutation { addNote(authorId: "u1", title: "x") { id } }'),
        { headers: { accept: 'application/json' } },
      ),
    );

    // A method refusal is a transport decision, so it survives the watershed
    // that turns GraphQL errors into 200s.
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');

    await app.stop();
  });

  it('keeps the 405 when a formatError hook reshapes errors', async () => {
    // Regression: the watershed used to read the error CODE out of the response
    // payload, which `formatError` runs last and may rewrite. A hook that
    // dropped `extensions` turned a refused mutation-over-GET into a 200 — a
    // success status for a request the server refused, alongside an `Allow`
    // header. The status must not be a function of the body.
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        GraphqlPlugin({
          typeDefs,
          resolvers: { Query: { mustExist: () => 'x' } } as never,
          formatError: (e) => ({ message: (e as { message: string }).message }),
        }),
      ],
    });
    await app.start();

    const res = await app.fetch(
      new Request(
        'http://localhost/graphql?query=' +
          encodeURIComponent('mutation { addNote(authorId: "u1", title: "x") { id } }'),
        { headers: { accept: 'application/json' } },
      ),
    );

    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
    // ...and the hook really did strip the code, so the assertion is not vacuous.
    const body = await res.json() as { errors: Array<{ extensions?: unknown }> };
    expect(body.errors[0]?.extensions).toBeUndefined();

    await app.stop();
  });

  it('answers 200 when an executed operation nulls data via a field error', async () => {
    const app = createApp();
    await app.start();

    const res = await post(app, { query: '{ mustExist }' }, 'application/graphql-response+json');

    // The operation ran; a field error nulling `data` is not a request error, so
    // this must not be a 400 even under strict negotiation.
    expect(res.statusCode).toBe(200);
    const body = await res.json() as { data: unknown; errors: Array<{ message: string }> };
    expect(body.data).toBeNull();
    expect(body.errors.length).toBe(1);

    await app.stop();
  });

  it('answers transport failures in the negotiated media type', async () => {
    const app = createApp();
    await app.start();

    // A client that asked for the strict media type must not be handed
    // `application/json` just because the failure happened before execution.
    const unsupported = await app.fetch(
      new Request('http://localhost/graphql', {
        method: 'POST',
        headers: { 'content-type': 'text/plain', accept: 'application/graphql-response+json' },
        body: 'not json',
      }),
    );
    expect(unsupported.status).toBe(415);
    expect(unsupported.headers.get('content-type')).toBe(
      'application/graphql-response+json; charset=utf-8',
    );

    const malformed = await app.fetch(
      new Request('http://localhost/graphql', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/graphql-response+json',
        },
        body: '{not json',
      }),
    );
    expect(malformed.status).toBe(400);
    expect(malformed.headers.get('content-type')).toBe(
      'application/graphql-response+json; charset=utf-8',
    );

    // A client that asked for nothing in particular still gets JSON.
    const plain = await app.fetch(
      new Request('http://localhost/graphql', {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: 'x',
      }),
    );
    expect(plain.headers.get('content-type')).toBe('application/json; charset=utf-8');

    await app.stop();
  });

  it('refuses an array as POST variables, exactly as GET does', async () => {
    const app = createApp();
    await app.start();

    const query = 'query($limit: Int) { user(id: "u1") { notes(limit: $limit) { id } } }';

    const viaPost = await post(app, { query, variables: [] }, 'application/graphql-response+json');
    const viaGet = await app.fetch(
      new Request(
        'http://localhost/graphql?query=' + encodeURIComponent(query) +
          '&variables=' + encodeURIComponent('[]'),
        { headers: { accept: 'application/graphql-response+json' } },
      ),
    );

    // `typeof [] === 'object'`, so POST used to accept the array and hand it to
    // execute as the variable map while GET rejected the same input.
    expect(viaPost.statusCode).toBe(400);
    expect(viaGet.status).toBe(400);
    const postBody = await viaPost.json() as { errors: Array<{ extensions?: { code?: string } }> };
    expect(postBody.errors[0]?.extensions?.code).toBe('INVALID_VARIABLES');

    // `null` remains valid — the spec allows it and it means "no variables".
    const withNull = await post(app, { query: '{ user(id: "u1") { id } }', variables: null });
    expect(withNull.statusCode).toBe(200);

    await app.stop();
  });

  it('answers 400 with OPERATION_RESOLUTION_FAILED for an ambiguous document', async () => {
    const app = createApp();
    await app.start();

    const res = await post(
      app,
      { query: 'query A { user(id: "u1") { id } } query B { user(id: "u1") { id } }' },
      'application/graphql-response+json',
    );

    expect(res.statusCode).toBe(400);
    const body = await res.json() as { errors: Array<{ extensions?: { code?: string } }> };
    expect(body.errors[0]?.extensions?.code).toBe('OPERATION_RESOLUTION_FAILED');

    // Naming the operation resolves it.
    const named = await post(app, {
      query: 'query A { user(id: "u1") { id } } query B { user(id: "u1") { displayName } }',
      operationName: 'B',
    });
    expect(named.statusCode).toBe(200);
    expect(await named.json()).toEqual({ data: { user: { displayName: 'Ada' } } });

    await app.stop();
  });

  it('fails at startup when the resolver map names a field the schema lacks', async () => {
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        GraphqlPlugin({
          typeDefs: 'type Query { hello: String }',
          // `typo` is not a field of Query. A silently ignored resolver typo is
          // indistinguishable at the wire from a legitimate null, so this must
          // fail at register() rather than at the first request.
          resolvers: { Query: { hello: () => 'x', typo: () => 'y' } },
        }),
      ],
    });

    let thrown: Error | undefined;
    try {
      await app.start();
    } catch (e) {
      thrown = e as Error;
    }

    expect(thrown).toBeDefined();
    expect(thrown!.message).toContain('typo');
  });
});
