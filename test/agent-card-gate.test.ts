import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import { PUBLISHED_PACKAGES } from '../scripts/release-packages.ts';
import {
  allowedCardIdentifiers,
  checkFences,
  exportedIdentifiers,
  identifierProblems,
  prematureResolutions,
} from './fixtures/snippets/agent-card-checks.ts';

/** Temporary handoff inventory: remove each entry when its card lands. */
const PENDING_CARDS: readonly string[] = [];
const FENCE_COUNTS: Readonly<Record<string, number>> = {
  'packages/kernel': 2,
  'packages/runtime': 2,
  'packages/testing': 2,
  'packages/exceptions': 2,
  'packages/sdk': 2,
  'packages/config-plugin': 2,
  'packages/logger-plugin': 2,
  'packages/validation-plugin': 2,
  'packages/http-security-plugin': 2,
  'packages/common': 2,
  'packages/queue-plugin': 2,
  'packages/decorator-plugin': 1,
  'packages/health-plugin': 2,
  'packages/metrics-plugin': 2,
  'packages/openapi-plugin': 2,
  'packages/auth-plugin': 2,
  'packages/session-plugin': 2,
  'packages/cache-plugin': 2,
  'packages/database-plugin': 2,
  'packages/events-plugin': 2,
  'packages/cqrs-plugin': 2,
  'packages/di-plugin': 1,
  'packages/messaging-plugin': 2,
  'packages/scheduler-plugin': 2,
  'packages/storage-plugin': 2,
  'packages/mail-plugin': 2,
  'packages/notification-plugin': 2,
  'packages/websocket-plugin': 2,
  'packages/sse-plugin': 2,
  'packages/realtime-backplane-plugin': 2,
  'packages/resilience-plugin': 1,
  'packages/service-discovery-plugin': 2,
  'packages/audit-plugin': 2,
  'packages/feature-flags-plugin': 2,
  'packages/idempotency-plugin': 1,
  'packages/localization-plugin': 2,
  'packages/multi-tenancy-plugin': 2,
  'packages/secrets-plugin': 2,
  'packages/static-plugin': 2,
  'packages/telemetry-plugin': 2,
  'packages/view-plugin': 2,
  'packages/graphql-plugin': 2,
  'packages/grpc-plugin': 2,
  'packages/react-router-plugin': 2,
  'packages/cloudflare-plugin': 2,
  'packages/worker-pool-plugin': 2,
  'packages/diagnostics-plugin': 2,
  'packages/starters/rest-starter': 1,
  'packages/starters/microservice-starter': 1,
  'packages/starters/full-stack-starter': 2,
};
const libraries = PUBLISHED_PACKAGES.filter((p) => p !== 'packages/cli' && p !== 'packages/create');
const ready = libraries.filter((p) => !PENDING_CARDS.includes(p));
let inventory: ReadonlyMap<string, ReadonlySet<string>>;
beforeAll(async () => {
  inventory = await exportedIdentifiers(PUBLISHED_PACKAGES);
});

describe('export-shaped inline identifiers', () => {
  it.each([
    ['`ctx.params.id`', []],
    ['`processors`', []],
    ['`@Inventedd`', ['Inventedd']],
    ['`inventedFn(`', ['inventedFn']],
    ['`inventedFn<string>`', ['inventedFn']],
    ['`NotExported`', ['NotExported']],
    ['`NotExported.field`', ['NotExported']],
    ['`@inventedFn(`', ['inventedFn']],
    ['`inventedFn (`', []],
    ['`NotExported/path`', []],
    ['`@setu-ts/NotExported`', []],
    ['`npxNotExported`', []],
    ['`npmNotExported`', []],
    ['`bunNotExported`', []],
    ['`denoNotExported`', []],
    ['`setuNotExported`', []],
    ['`Promise<string>`', []],
    ['`JSON.stringify`', []],
    ['<!-- card-allow: createApp -->\n`createApp(`', []],
    ['```ts\nNotExported();\n```', []],
  ])('checks literal %s', (source, expected) => {
    expect(identifierProblems(source, new Set())).toEqual(expected);
  });
  it.each([
    ['`QueuePlugin(`', []],
    ['`IQueue`', []],
    ['`createTestApp(`', ['createTestApp']],
    ['@setu-ts/testing\n`createTestApp(`', []],
    ['@setu-ts/testing-extra\n`createTestApp(`', ['createTestApp']],
    ['@setu-ts/rest-starter\n`createRestApp(`', []],
    ['<!-- card-allow: createApp -->\n`createApp(`', []],
  ])('uses only own, common and explicitly named package exports: %s', (source, expected) => {
    expect(
      identifierProblems(
        source,
        allowedCardIdentifiers(source, 'packages/queue-plugin', inventory),
      ),
    ).toEqual(expected);
  });
});

describe('capabilities resolved before start()', () => {
  const fence = (body: string): string => '```ts\n' + body + '\n```\n';
  it('flags app.services.get with no earlier app.start()', () => {
    expect(prematureResolutions(fence('const db = app.services.get(T);'))).toEqual([0]);
    expect(prematureResolutions(fence('app.services.get(T);\nawait app.start();'))).toEqual([0]);
  });
  it('accepts a resolution after start, a handler read, and a fence without one', () => {
    expect(prematureResolutions(fence('await app.start();\napp.services.get(T);'))).toEqual([]);
    expect(prematureResolutions(fence('(ctx) => ctx.services.get(T)'))).toEqual([]);
    expect(
      prematureResolutions(
        fence('const x = 1;') + fence('await app.start();\napp.services.get(T);'),
      ),
    ).toEqual([]);
  });
});

describe('published agent cards', () => {
  it('accounts for every library, with pending entries absent so the list can only shrink', async () => {
    expect(new Set(PENDING_CARDS).size).toBe(PENDING_CARDS.length);
    for (const pkg of PENDING_CARDS) {
      expect(libraries).toContain(pkg);
      await expect(readFile(`${pkg}/AGENT_CARD.md`)).rejects.toMatchObject({ code: 'ENOENT' });
    }
    expect(Object.keys(FENCE_COUNTS).sort()).toEqual([...ready].sort());
  });
  it('keeps each card nonempty and within 2560 bytes', async () => {
    for (const pkg of ready) {
      const bytes = await readFile(`${pkg}/AGENT_CARD.md`);
      expect(bytes.length, pkg).toBeLessThanOrEqual(2560);
      expect(bytes.toString().trim(), pkg).not.toBe('');
      expect(bytes.toString(), pkg).not.toMatch(/^>\s*```/m);
    }
  });
  it('refuses invented inline identifiers', async () => {
    for (const pkg of ready) {
      const path = `${pkg}/AGENT_CARD.md`;
      const source = await readFile(path, 'utf8');
      const allowed = allowedCardIdentifiers(source, pkg, inventory);
      expect(identifierProblems(source, allowed), path).toEqual([]);
    }
  });
  it('starts the application before resolving a capability from it', async () => {
    for (const pkg of ready) {
      const path = `${pkg}/AGENT_CARD.md`;
      expect(prematureResolutions(await readFile(path, 'utf8')), path).toEqual([]);
    }
  });
  it('compiles every fence and pins the compilable count', async () => {
    for (const pkg of ready) {
      const path = `${pkg}/AGENT_CARD.md`;
      expect(
        await checkFences(path, await readFile(path, 'utf8'), '.tmp/agent-card-fences'),
        path,
      ).toBe(FENCE_COUNTS[pkg]);
    }
  });
});
