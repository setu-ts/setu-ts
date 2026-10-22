/**
 * Resolvers for the books schema, including a subscription's `subscribe`.
 */
import type { ResolverMap } from '@setu-ts/graphql-plugin';
import type { Book } from './books.schema.ts';

/**
 * The value an internal error carries, so a test can assert that masking
 * removed it rather than merely that some error arrived.
 */
export const INTERNAL_SECRET = 'postgres://admin:hunter2@db.internal:5432';

/** Builds a fresh resolver set over its own state, so each run starts clean. */
export function createResolvers(): ResolverMap {
  const books: Book[] = [
    { id: '1', title: 'The Left Hand of Darkness', author: 'Le Guin' },
    { id: '2', title: 'Piranesi', author: 'Clarke' },
  ];
  const listeners = new Set<(book: Book) => void>();

  const resolvers: ResolverMap = {
    Query: {
      hello: () => 'world',
      books: () => books,
      book: (_source, args) => books.find((b) => b.id === args.id) ?? null,
      boom: () => {
        throw new Error(INTERNAL_SECRET);
      },
    },
    Mutation: {
      addBook: (_source, args) => {
        const book: Book = {
          id: String(books.length + 1),
          title: String(args.title),
          author: String(args.author),
        };
        books.push(book);
        for (const listener of listeners) listener(book);
        return book;
      },
    },
    Subscription: {
      // A subscription field is `{ subscribe, resolve? }`; `subscribe` returns
      // the event source and graphql reads it from the field's own slot.
      countdown: {
        subscribe: (_source, args) =>
          (async function* () {
            for (let i = Number(args.from); i >= 0; i--) {
              yield { countdown: i };
              await new Promise((resolve) => setTimeout(resolve, 100));
            }
          })(),
      },
      // Pushed by the mutation, so one test can prove a write on the HTTP
      // transport reaches a subscriber on another transport.
      bookAdded: {
        subscribe: () => {
          const queue: Book[] = [];
          let deliver: ((book: Book) => void) | undefined;
          const listener = (book: Book) => {
            if (deliver) {
              deliver(book);
              deliver = undefined;
            } else {
              queue.push(book);
            }
          };
          listeners.add(listener);
          return {
            async *[Symbol.asyncIterator]() {
              try {
                while (true) {
                  const next =
                    queue.shift() ?? (await new Promise<Book>((resolve) => (deliver = resolve)));
                  yield { bookAdded: next };
                }
              } finally {
                listeners.delete(listener);
              }
            },
          };
        },
      },
    },
  };

  return resolvers;
}
