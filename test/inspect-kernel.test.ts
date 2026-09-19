import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

/**
 * Exercises `scripts/inspect-kernel.ts` as a real SUBPROCESS and asserts on
 * its stdout: the public DTOs a consumer reads. This is the script's
 * consumer contract — it must run against the public barrels alone, bind no
 * port, and emit only the snapshot and batch DTOs.
 */
async function runInspectScript(): Promise<{ stdout: string; stderr: string; code: number }> {
  const command = new Deno.Command(Deno.execPath(), {
    args: ['run', '--allow-read', '--allow-env', 'scripts/inspect-kernel.ts'],
    cwd: Deno.cwd(),
    stdout: 'piped',
    stderr: 'piped',
  });
  const result = await command.output();
  return {
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
    code: result.code,
  };
}

/**
 * Extracts every top-level JSON object from a stream, in order, by brace
 * counting — the script emits the snapshot and the batch as two successive
 * pretty-printed documents.
 *
 * @param text - The stream to scan
 * @returns The parsed objects
 */
function extractJsonDocuments(text: string): unknown[] {
  const documents: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') {
      if (depth === 0) start = index;
      depth++;
      continue;
    }
    if (char === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        documents.push(JSON.parse(text.slice(start, index + 1)));
        start = -1;
      }
    }
  }
  return documents;
}

describe('inspect-kernel consumer script', () => {
  it('runs as a real subprocess and emits the public DTOs', async () => {
    const { stdout, code } = await runInspectScript();
    expect(code).toBe(0);
    expect(stdout).toContain('injected GET /items -> 200');

    const documents = extractJsonDocuments(stdout);
    expect(documents.length).toBe(2);
    const snapshot = documents[0] as {
      version: number;
      state: string;
      instanceId: string;
      nodes: readonly { kind: string; label?: string }[];
      edges: readonly unknown[];
      truncated: boolean;
      droppedEvents: number;
    };
    expect(snapshot.version).toBe(1);
    expect(snapshot.state).toBe('running');
    expect(snapshot.instanceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(snapshot.nodes.length).toBeGreaterThan(0);
    expect(snapshot.edges.length).toBeGreaterThan(0);
    expect(snapshot.truncated).toBe(false);
    expect(snapshot.droppedEvents).toBe(0);

    // Allowlisted labels appear; un-allowlisted identities do not.
    const labels = snapshot.nodes.map((node) => node.label).filter((label) => label !== undefined);
    expect(labels).toContain('catalog');
    expect(labels).toContain('catalog-items');
    expect(labels).toContain('/items');
    expect(labels).toContain('request-log');
  });

  it('emits the batch DTO and captures no raw request data', async () => {
    const { stdout } = await runInspectScript();
    const documents = extractJsonDocuments(stdout);
    const batch = documents[1] as {
      version: number;
      events: readonly { stage: string; operationId: string; sequence: number }[];
      next: number;
      lost: number;
      closed: boolean;
    };
    expect(batch.version).toBe(1);
    expect(batch.events.length).toBeGreaterThan(0);
    expect(batch.closed).toBe(false);
    expect(batch.lost).toBe(0);
    expect(batch.events.some((event) => event.stage === 'request')).toBe(true);
    expect(batch.events.some((event) => event.stage === 'handler')).toBe(true);

    // No URL, header, body, or live object ever leaves the process.
    expect(stdout).not.toContain('localhost');
    expect(stdout).not.toContain('"headers"');
    expect(stdout).not.toContain('"body"');
  });

  it('binds no port', async () => {
    const { stderr } = await runInspectScript();
    // A bound socket would surface a listen error or a port line; none.
    expect(stderr).toBe('');
  });
});
