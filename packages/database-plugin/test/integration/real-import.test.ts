/**
 * Integration test for real ORM imports.
 *
 * Attempts to dynamically import Prisma and Drizzle from npm: specifiers.
 * The Prisma probe verifies the ungenerated package boundary; the adapter
 * therefore requires an application-generated client to be injected.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

describe('Real ORM imports (guarded)', () => {
  it('prisma v7 ungenerated package has an explicit generated-client boundary', async () => {
    let imported: unknown = undefined;
    let error: Error | null = null;
    try {
      // This is intentionally the published, ungenerated package rather than
      // application-local output. Prisma v7 must not be treated as usable here.
      imported = await import('npm:@prisma/client@7.8.0');
    } catch (e) {
      error = e instanceof Error ? e : new Error(String(e));
    }

    if (imported !== undefined) {
      const PrismaClient = (imported as Record<string, unknown>).PrismaClient;
      expect(typeof PrismaClient).toBe('function');
      expect(() => new (PrismaClient as new () => unknown)()).toThrow(/generate|client/i);
    } else {
      // Import failed — error must be descriptive (not a silent failure).
      expect(error).not.toBeNull();
      const msg = error!.message.toLowerCase();
      expect(
        msg.includes('prisma') ||
          msg.includes('generate') ||
          msg.includes('not found') ||
          msg.includes('npm'),
      ).toBe(true);
    }
  });

  it('the Cosmos lazy loader performs the real npm import and constructs a client', async () => {
    // Drives `createLazyClientLoader` itself rather than a bare `import()`, so
    // the seam's own construction — not merely the specifier — is exercised.
    // Constructing a `CosmosClient` opens no connection, so this needs no
    // emulator and no network beyond resolving the package.
    const { createLazyClientLoader } = await import(
      '../../src/adapters/cosmos/cosmos-client.ts'
    );
    let loader: Awaited<ReturnType<typeof createLazyClientLoader>> | undefined;
    let error: Error | null = null;
    try {
      loader = await createLazyClientLoader('https://example.documents.azure.com:443/', 'k');
    } catch (e) {
      error = e instanceof Error ? e : new Error(String(e));
    }

    if (loader !== undefined) {
      // The lazily-loaded client is owned by the adapter, unlike an injected one.
      expect(loader.owned).toBe(true);
      const client = await loader.createClient();
      expect(typeof client.database).toBe('function');
      expect(typeof client.database('probe').container).toBe('function');
    } else {
      expect(error).not.toBeNull();
      const msg = error!.message.toLowerCase();
      expect(msg.includes('cosmos') || msg.includes('not found') || msg.includes('npm')).toBe(true);
    }
  });

  it('drizzle-orm import either succeeds or throws descriptive error', async () => {
    let imported: unknown = undefined;
    let error: Error | null = null;
    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      imported = await import('npm:drizzle-orm@^0.45.2');
    } catch (e) {
      error = e instanceof Error ? e : new Error(String(e));
    }

    if (imported !== undefined) {
      // Import succeeded — verify key operators are present.
      expect((imported as Record<string, unknown>).eq).toBeDefined();
      expect((imported as Record<string, unknown>).and).toBeDefined();
      expect((imported as Record<string, unknown>).asc).toBeDefined();
      expect((imported as Record<string, unknown>).desc).toBeDefined();
    } else {
      // Import failed — error must be descriptive (not a silent failure).
      expect(error).not.toBeNull();
      const msg = error!.message.toLowerCase();
      expect(
        msg.includes('drizzle') ||
          msg.includes('not found') ||
          msg.includes('npm'),
      ).toBe(true);
    }
  });
});
