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
const PENDING_CARDS: readonly string[] = [
  'packages/audit-plugin',
  'packages/cloudflare-plugin',
  'packages/diagnostics-plugin',
  'packages/feature-flags-plugin',
  'packages/graphql-plugin',
  'packages/grpc-plugin',
  'packages/idempotency-plugin',
  'packages/localization-plugin',
  'packages/multi-tenancy-plugin',
  'packages/react-router-plugin',
  'packages/secrets-plugin',
  'packages/static-plugin',
  'packages/telemetry-plugin',
  'packages/view-plugin',
  'packages/worker-pool-plugin',
  'packages/starters/rest-starter',
  'packages/starters/microservice-starter',
  'packages/starters/full-stack-starter',
];
const FENCE_COUNTS: Readonly<Record<string, number>> = {
  'packages/kernel': 1,
  'packages/runtime': 1,
  'packages/testing': 2,
  'packages/exceptions': 1,
  'packages/sdk': 2,
  'packages/config-plugin': 2,
  'packages/logger-plugin': 1,
  'packages/validation-plugin': 1,
  'packages/http-security-plugin': 1,
  'packages/common': 2,
  'packages/queue-plugin': 2,
  'packages/decorator-plugin': 1,
  'packages/health-plugin': 2,
  'packages/metrics-plugin': 2,
  'packages/openapi-plugin': 2,
  'packages/auth-plugin': 1,
  'packages/session-plugin': 1,
  'packages/cache-plugin': 2,
  'packages/database-plugin': 2,
  'packages/events-plugin': 2,
  'packages/cqrs-plugin': 2,
  'packages/di-plugin': 2,
  'packages/messaging-plugin': 2,
  'packages/scheduler-plugin': 1,
  'packages/storage-plugin': 2,
  'packages/mail-plugin': 1,
  'packages/notification-plugin': 1,
  'packages/websocket-plugin': 1,
  'packages/sse-plugin': 1,
  'packages/realtime-backplane-plugin': 1,
  'packages/resilience-plugin': 1,
  'packages/service-discovery-plugin': 1,
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
