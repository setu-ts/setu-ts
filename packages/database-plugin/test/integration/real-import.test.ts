/**
 * Integration test for real ORM imports.
 *
 * Attempts to dynamically import Prisma and Drizzle from npm: specifiers.
 * Guards with try/catch so network failures or missing binaries don't fail CI.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

describe('Real ORM imports (guarded)', () => {
  it('prisma client import either succeeds or throws descriptive error', async () => {
    let imported: unknown = undefined;
    let error: Error | null = null;
    try {
      // Match the version the adapter lazily imports (see prisma-adapter.ts).
      imported = await import('npm:@prisma/client@7.8.0');
    } catch (e) {
      error = e instanceof Error ? e : new Error(String(e));
    }

    if (imported !== undefined) {
      // Import succeeded — Prisma client module loaded.
      expect(imported).toBeDefined();
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
