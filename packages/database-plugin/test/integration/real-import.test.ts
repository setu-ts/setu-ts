/**
 * Integration test for real ORM imports.
 *
 * Attempts to dynamically import Prisma and Drizzle from npm: specifiers.
 * The Prisma probe verifies the ungenerated package boundary; the adapter
 * therefore requires an application-generated client to be injected.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
} from 'npm:@aws-sdk/client-dynamodb@^3';
import { createLazyDynamoLoader } from '../../src/index.ts';

const dynamoEndpoint = Deno.env.get('DYNAMODB_ENDPOINT');
const skipDynamo = dynamoEndpoint === undefined;
const endpoint = dynamoEndpoint ?? '';
const dynamoCredentials = {
  accessKeyId: 'setum80fake',
  secretAccessKey: 'setum80secret',
};
const dynamoRegion = 'us-east-1';

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

  it(
    'DynamoDB lazy SDK import drives a facade command round trip',
    { ignore: skipDynamo },
    async () => {
      const tableName = `m80_import_${crypto.randomUUID().replaceAll('-', '')}`;
      const admin = new DynamoDBClient({
        endpoint,
        region: dynamoRegion,
        credentials: dynamoCredentials,
      });
      await admin.send(
        new CreateTableCommand({
          TableName: tableName,
          BillingMode: 'PAY_PER_REQUEST',
          AttributeDefinitions: [{ AttributeName: 'id', AttributeType: 'S' }],
          KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
        }),
      );
      try {
        const loader = createLazyDynamoLoader({
          endpoint,
          region: dynamoRegion,
          credentials: dynamoCredentials,
        });
        const client = await loader.load();
        await expect(client.scan({ TableName: tableName })).resolves.toMatchObject({ Count: 0 });
      } finally {
        await admin.send(new DeleteTableCommand({ TableName: tableName }));
        admin.destroy();
      }
    },
  );
});
