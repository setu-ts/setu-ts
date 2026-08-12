/** Renders the dependency-aware development runner owned by a workspace root. */

import type { WorkspaceRuntimeProfile } from './runtime-profile.ts';

/** The generated runner filename, relative to the workspace root. */
export const DEV_RUNNER = 'scripts/dev';

/**
 * Renders a runner that starts dependency services first and gates dependents on `/ready`.
 *
 * @param profile - The workspace runtime that owns process creation
 * @returns One generated runner file
 */
export function workspaceDevRunner(profile: WorkspaceRuntimeProfile): {
  readonly path: string;
  readonly contents: string;
} {
  return profile.runtime === 'deno' ? { path: `${DEV_RUNNER}.ts`, contents: denoRunner() } : {
    path: `${DEV_RUNNER}.mjs`,
    contents: nodeRunner(profile.runtime === 'bun' ? 'bun' : 'node'),
  };
}

function denoRunner(): string {
  return `type Member = { name: string; port: number; dependsOn?: string[] };

const manifest = JSON.parse(await Deno.readTextFile('setu.workspace.json')) as { members: Member[] };
const members = new Map(manifest.members.map((member) => [member.name, member]));
const started = new Set<string>();
const visiting = new Set<string>();
const children: Deno.ChildProcess[] = [];

const pause = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const shutdown = () => { for (const child of children) { try { child.kill('SIGTERM'); } catch {} } };

async function waitForReady(member: Member): Promise<void> {
  const deadline = performance.now() + 30_000;
  while (performance.now() < deadline) {
    try { if ((await fetch(\`http://127.0.0.1:\${member.port}/ready\`)).ok) return; } catch {}
    await pause(100);
  }
  throw new Error(\`Dependency "\${member.name}" did not become ready within 30 seconds.\`);
}

async function start(member: Member): Promise<void> {
  if (started.has(member.name)) return;
  if (visiting.has(member.name)) throw new Error(\`Dependency cycle includes "\${member.name}".\`);
  visiting.add(member.name);
  for (const name of member.dependsOn ?? []) {
    const dependency = members.get(name);
    if (dependency === undefined) throw new Error(\`Unknown dependency "\${name}" for "\${member.name}".\`);
    await start(dependency);
    await waitForReady(dependency);
  }
  visiting.delete(member.name);
  const child = new Deno.Command('deno', { args: ['task', 'start'], cwd: \`apps/\${member.name}\`, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' }).spawn();
  children.push(child);
  started.add(member.name);
  void child.status.then((status) => { if (!status.success) { shutdown(); Deno.exit(status.code); } });
}

try { for (const member of manifest.members) await start(member); } catch (cause) { shutdown(); throw cause; }
Deno.addSignalListener('SIGINT', () => { shutdown(); Deno.exit(); });
Deno.addSignalListener('SIGTERM', () => { shutdown(); Deno.exit(); });
`;
}

function nodeRunner(runtime: 'node' | 'bun'): string {
  const executable = runtime === 'bun' ? 'bun' : 'npm';
  const args = "['run', 'start']";
  return `import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';

const manifest = JSON.parse(await readFile('setu.workspace.json', 'utf8'));
const members = new Map(manifest.members.map((member) => [member.name, member]));
const started = new Set();
const visiting = new Set();
const children = [];

const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const shutdown = () => { for (const child of children) { try { child.kill('SIGTERM'); } catch {} } };

async function waitForReady(member) {
  const deadline = performance.now() + 30_000;
  while (performance.now() < deadline) {
    try { if ((await fetch(\`http://127.0.0.1:\${member.port}/ready\`)).ok) return; } catch {}
    await pause(100);
  }
  throw new Error(\`Dependency "\${member.name}" did not become ready within 30 seconds.\`);
}

async function start(member) {
  if (started.has(member.name)) return;
  if (visiting.has(member.name)) throw new Error(\`Dependency cycle includes "\${member.name}".\`);
  visiting.add(member.name);
  for (const name of member.dependsOn ?? []) {
    const dependency = members.get(name);
    if (dependency === undefined) throw new Error(\`Unknown dependency "\${name}" for "\${member.name}".\`);
    await start(dependency);
    await waitForReady(dependency);
  }
  visiting.delete(member.name);
  const child = spawn('${executable}', ${args}, { cwd: \`apps/\${member.name}\`, stdio: 'inherit' });
  children.push(child);
  started.add(member.name);
  child.once('exit', (code) => { if (code !== 0) { shutdown(); process.exitCode = code ?? 1; } });
}

try { for (const member of manifest.members) await start(member); } catch (cause) { shutdown(); throw cause; }
process.on('SIGINT', () => { shutdown(); process.exit(); });
process.on('SIGTERM', () => { shutdown(); process.exit(); });
`;
}
