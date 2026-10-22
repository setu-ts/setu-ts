/** A book record as the demo stores it. */
export interface Book {
  id: string;
  title: string;
  author: string;
}

/** The SDL served by the demo. */
export const typeDefs = `
  type Book { id: ID!, title: String!, author: String! }

  type Query {
    hello: String!
    books: [Book!]!
    book(id: ID!): Book
    """Always throws, to show internal-error masking on every transport."""
    boom: String!
  }

  type Mutation {
    addBook(title: String!, author: String!): Book!
  }

  type Subscription {
    """Emits \`from\` down to 0, then completes."""
    countdown(from: Int!): Int!
    """Emits every book added by the addBook mutation, on any transport."""
    bookAdded: Book!
  }
`;
