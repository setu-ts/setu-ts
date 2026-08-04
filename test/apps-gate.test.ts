import { expect } from '@std/expect';
import { describe, it } from '@std/testing/bdd';

interface RootConfig {
  readonly workspace: readonly string[];
}

interface AppConfig {
  readonly tasks?: Readonly<Record<string, string>>;
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await Deno.readTextFile(path)) as T;
}

describe('application gate configuration', () => {
  it('keeps applications outside the published workspace', async () => {
    const root = await readJson<RootConfig>('deno.json');
    expect(root.workspace.some((entry) => entry.includes('apps'))).toBe(false);
  });

  it('requires every example application to declare start and smoke tasks', async () => {
    for await (const entry of Deno.readDir('apps')) {
      if (!entry.isDirectory) continue;
      const config = await readJson<AppConfig>(`apps/${entry.name}/deno.json`);
      expect(config.tasks?.start).toBeDefined();
      expect(config.tasks?.smoke).toBeDefined();
    }
  });
});
