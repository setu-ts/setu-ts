/** Additive schema-migration tooling; data migrations remain a separate CLI seam. @module */
import type { TargetRuntime } from '../constants.ts';
import { CLIENT_RANGES } from '../templates/client-dependencies.ts';

/** Adds missing backend scripts and its CLI, preserving every existing script and pin. */
export function withDatabaseScripts(
  source: string,
  type: string,
  runtime: TargetRuntime,
  log: (line: string) => void,
): string | undefined {
  if (!['drizzle', 'prisma'].includes(type) || runtime === 'cloudflare-workers') return undefined;
  const commands =
    type === 'drizzle'
      ? { 'db:generate': 'drizzle-kit generate', 'db:migrate': 'drizzle-kit migrate' }
      : {
          'db:generate': 'prisma generate',
          'db:migrate': 'prisma migrate dev',
          'db:deploy': 'prisma migrate deploy',
        };
  if (runtime === 'deno') {
    for (const [name, command] of Object.entries(commands)) log(`${name}: ${command}`);
    return undefined;
  }
  const parsed = JSON.parse(source) as Record<string, unknown>;
  const scripts = parsed['scripts'];
  const dev = parsed['devDependencies'];
  if (
    (scripts !== undefined &&
      (scripts === null || typeof scripts !== 'object' || Array.isArray(scripts))) ||
    (dev !== undefined && (dev === null || typeof dev !== 'object' || Array.isArray(dev)))
  ) {
    log(
      'left package.json database scripts unchanged: scripts or devDependencies is not an object.',
    );
    return undefined;
  }
  let changed = false;
  const next = { ...(scripts as Record<string, unknown> | undefined) };
  for (const [name, command] of Object.entries(commands)) {
    if (Object.hasOwn(next, name)) log(`left package.json ${name} unchanged: already present.`);
    else {
      next[name] = command;
      changed = true;
    }
  }
  const tool = type === 'drizzle' ? 'drizzle-kit' : 'prisma';
  const pinned = [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
  ].some((key) => {
    const value = parsed[key];
    return value !== null && typeof value === 'object' && Object.hasOwn(value, tool);
  });
  if (!pinned) {
    parsed['devDependencies'] = {
      ...(dev as Record<string, unknown> | undefined),
      [tool]: CLIENT_RANGES[tool],
    };
    changed = true;
  }
  return changed ? JSON.stringify({ ...parsed, scripts: next }, null, 2) + '\n' : undefined;
}

/** Create-only config the chosen schema tool reads; schemas belong to the application. */
export function databaseConfig(
  type: string,
  dialect: string,
): { readonly path: string; readonly contents: string; readonly schema: string } | undefined {
  if (type === 'drizzle')
    return {
      path: 'drizzle.config.ts',
      schema: 'src/database/schema.ts',
      contents: `import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: '${dialect}',
  schema: './src/database/schema.ts',
  out: './drizzle',
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
});
`,
    };
  if (type === 'prisma')
    return {
      path: 'prisma.config.ts',
      schema: 'prisma/schema.prisma',
      contents: `import process from 'node:process';

export default {
  schema: './prisma/schema.prisma',
  migrations: { path: './prisma/migrations' },
  datasource: { url: process.env.DATABASE_URL ?? '' },
};
`,
    };
  return undefined;
}
