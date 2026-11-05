import { readFile, readdir } from 'node:fs/promises';
import ts from 'typescript';
import { expect, it } from 'vitest';
import {
  cliCommand,
  cliInvocation,
  projectFiles,
  resolveHost,
} from '../../src/templates/project-files.ts';
import { PROTO_TASK_COMMAND, protoToolchainFiles } from '../../src/workspace/proto-toolchain.ts';
import { FULL_STACK_TEMPLATE } from '../../src/templates/full-stack.ts';
import { REST_TEMPLATE } from '../../src/templates/rest.ts';
import { planViewSetup } from '../../src/commands/add-view.ts';

it('M2 X87-4 matches every Deno npm command including arrays and checks emitted tools', async () => {
  const commands: string[] = [];
  const walk = async (dir: URL): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!entry.name.endsWith('.ts')) continue;
      const source = ts.createSourceFile(
        path.pathname,
        await readFile(path, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
      );
      const inspect = (node: ts.Node): void => {
        if (
          ts.isStringLiteral(node) ||
          ts.isNoSubstitutionTemplateLiteral(node) ||
          ts.isTemplateHead(node) ||
          ts.isTemplateMiddle(node) ||
          ts.isTemplateTail(node)
        ) {
          commands.push(
            ...[...node.text.matchAll(/deno run[^\n'"\x60]*npm:/g)].map((match) => match[0]),
          );
          commands.push(
            ...[
              ...node.text.matchAll(
                /\[\s*['"]deno['"]\s*,\s*['"]run['"][^\]]*['"]npm:[^'"]*['"][^\]]*\]/g,
              ),
            ].map((match) => match[0]),
          );
        }
        if (ts.isArrayLiteralExpression(node)) {
          const parts = node.elements.filter(ts.isStringLiteral).map((element) => element.text);
          if (
            parts[0] === 'deno' &&
            parts[1] === 'run' &&
            parts.some((part) => part.startsWith('npm:'))
          )
            commands.push(parts.join(' '));
        }
        ts.forEachChild(node, inspect);
      };
      inspect(source);
    }
  };
  await walk(new URL('../../src/', import.meta.url));
  // Floor is the number of commands this source walk found when this regression was added.
  expect(commands.length).toBeGreaterThanOrEqual(5);
  expect(commands.filter((command) => !command.includes('--no-lock'))).toEqual([]);
  expect(cliCommand('deno', 'check')).toContain('--no-lock');
  expect(cliInvocation('deno')).toContain('--no-lock');
  expect(PROTO_TASK_COMMAND).toMatch(/deno run .*--no-lock .*npm:@bufbuild\/buf/);
  const buf = protoToolchainFiles('shop').find((file) => file.path === 'buf.gen.yaml')!.contents;
  expect(buf).toContain(
    "local: ['deno', 'run', '-A', '--no-lock', 'npm:@bufbuild/protoc-gen-es@^2']",
  );
  expect(FULL_STACK_TEMPLATE.manifest!.npmBuild!.denoCommand).toMatch(
    /deno run .*--no-lock .*npm:@react-router\/dev/,
  );
  const existing = new Map(
    projectFiles('shop', 'deno', resolveHost(REST_TEMPLATE, 'deno')).map((file) => [
      file.path,
      file.contents,
    ]),
  );
  const view = planViewSetup({
    runtime: 'deno',
    existing,
    viewPluginRegistered: true,
    wireStatic: (source) => source,
    controllerDir: 'src/controllers',
    registration: { path: 'src/controllers/index.ts', contents: '' },
  });
  const manifest = JSON.parse(
    view.manifestEdits.find((file) => file.path === 'deno.json')!.contents,
  );
  expect(manifest.tasks.css).toMatch(/deno run .*--no-lock .*npm:@tailwindcss\/cli/);
});
