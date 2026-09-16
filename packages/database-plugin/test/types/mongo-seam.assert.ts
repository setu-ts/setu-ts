/**
 * Compile-time assertion that the REAL `mongodb` driver satisfies the
 * documented injection seam.
 *
 * `PUBLIC_API.md` presents `IMongoClient` as the seam an application supplies a
 * real `MongoClient` through. That claim was false once: the facade declared
 * `connect(): Promise<void>` while the driver declares
 * `connect(): Promise<this>`, so the documented arm did not compile without the
 * cast this repository forbids internally (X47-1). It shipped because every
 * in-repo test injects a fake that satisfies the facade by construction, and
 * the one test that loads the real driver laundered it through a cast.
 *
 * This module is that guard, on the M70i precedent: it imports the real driver
 * STATICALLY — a dynamic `import()` inside a test body is exactly what let the
 * graphql facade drift, because `deno check` never compared the two type
 * worlds — and assigns a real `MongoClient` to `IMongoClient` with NO cast. It
 * is reached by `deno task check`, which type-checks every module under
 * `packages/`, and is deliberately NOT named `*.test.ts`, so `deno test` never
 * executes it: the assertion is the type-check itself. The moment the facade
 * drifts again, this file is the TS2322 that fails the build instead of an
 * application's.
 *
 * @module
 */
import { MongoClient } from 'npm:mongodb@^6.21.0';
import type { IMongoClient } from '../../src/adapters/mongo/mongo-client.ts';

// The assertion. No cast on either side: the type error IS the test.
const asSeam: IMongoClient = new MongoClient('mongodb://127.0.0.1:27017');

// Consumed by an export so `noUnusedLocals` cannot strip the assignment — and
// so a reader who follows the symbol finds this file rather than a dead value.
export const MONGO_SEAM_ASSERTION: IMongoClient = asSeam;
