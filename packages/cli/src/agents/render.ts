/** Pure renderers shared by writing and freshness checks. */
import type { ProjectFacts } from './facts.ts';
import type { WorkspaceManifest } from '../workspace/manifest.ts';
import { cliInvocation } from '../templates/project-files.ts';
import { notInstalledAddables } from './not-installed.ts';
import { PACKAGE_DATA, TOOLING_PACKAGES } from './package-data.ts';
import { RULE_BLOCKS } from './rules.ts';
import { BRIEF_BEGIN, BRIEF_END, briefSection } from './brief-file.ts';
import { isAgentPackageName } from './package-name.ts';
import { hasControlCharacter } from '../utils/names.ts';
import { getTransport } from '../workspace/transport.ts';
import { workspaceProfile } from '../workspace/runtime-profile.ts';

function displayValue(value: string | number): string {
  const text = String(value);
  return hasControlCharacter(text) || /[`|<>]/.test(text) ? '(not shown)' : text;
}

function checkedSection(section: string): string {
  briefSection(section);
  return section;
}

function introduction(version: string, modules = 'node_modules'): string {
  return `${BRIEF_BEGIN}\n\`setu agents\` reads manifests and overwrites these markers' contents.\n\n# Setu-TS ${version} — agent brief\n\nDo not guess Setu-TS APIs from NestJS, Express, Fastify or Hono.\n\n**Rule 0:** For symbols, options or patterns absent here and in project code, read \`${modules}/@setu-ts/<package>/AGENT_CARD.md\` and that package's \`dist/**/*.d.ts\`. What neither documents does not exist.\n`;
}

/** A member always directs agents to the workspace-wide layout first. */
export function renderMemberPointer(): string {
  return 'Read ../../AGENTS.md for workspace layout, ports and transport.\n';
}

function commandGloss(name: string, facts: ProjectFacts): string {
  switch (name) {
    case 'start':
      return facts.runtime === 'node'
        ? 'production entry; on Node, run build first'
        : 'production entry';
    case 'start:dev':
      return 'development loop; use this while editing';
    case 'start:debug':
      return 'development entry with the inspector';
    case 'dev': {
      const body = facts.commandBodies[name] ?? '';
      if (body.includes('wrangler dev'))
        return `development loop on workerd${facts.commands.includes('build') ? ' (builds first)' : ''}`;
      if (body.includes('main.dev.ts')) return 'development entry for a devtool session';
      return facts.commands.includes('start:dev')
        ? 'development entry that does not restart on server edits; prefer start:dev'
        : '';
    }
    default:
      return '';
  }
}

/** Render one project deterministically from its gathered facts. */
export function renderBrief(facts: ProjectFacts, member = false): string {
  const modules = member ? '../../node_modules' : 'node_modules';
  const cli = cliInvocation(facts.runtime);
  const profile = workspaceProfile(facts.runtime);
  const sections = [introduction(facts.version, modules)];
  if (member) sections.push(renderMemberPointer());
  sections.push(
    '## Commands\n',
    ...facts.commands.map((name) => {
      const gloss = commandGloss(name, facts);
      return `- \`${profile.runScript(name)}\`${gloss === '' ? '' : ` — ${gloss}`}`;
    }),
    `- \`${cli} generate <schematic> <name>\``,
    `- \`${cli} add <name>\` — install, then follow its registration guidance.`,
    '\n## Schematics in this project\n',
    facts.schematics.map((name) => `\`${name}\``).join(', '),
    '\n## Rules\n',
    ...RULE_BLOCKS.filter((rule) => rule.applies(facts)).map(
      (rule, index) => `${index + 1}. ${rule.text}`,
    ),
    '\n## Project map\n',
    '| Path | Purpose |',
    '| --- | --- |',
    '| setu.config.ts | Composition root; creates the app |',
    `| ${facts.runtime === 'cloudflare-workers' ? 'src/index.ts' : 'main.ts'} | Runtime entry |`,
    ...facts.seams.map((path) => `| ${path}/ | Generated artifacts; CLI owns the barrel |`),
    '| test/ | Application tests |',
    ...facts.directories.map((path) =>
      path === 'src/modules'
        ? `| ${path}/ | Feature modules; CLI owns each index.ts |`
        : `| ${path}/ | Project code |`,
    ),
    '\n## Installed packages\n',
    '| Package | CAPABILITIES keys | Description | Card |',
    '| --- | --- | --- | --- |',
  );
  for (const pkg of [...facts.installed].sort()) {
    if (!isAgentPackageName(pkg) || TOOLING_PACKAGES.has(pkg)) continue;
    const data = PACKAGE_DATA.get(pkg);
    sections.push(
      `| @setu-ts/${pkg} | ${data?.tokens.join(', ') || '—'} | ${data?.description ?? 'Read the installed package documentation'} | ${modules}/@setu-ts/${pkg}/AGENT_CARD.md |`,
    );
  }
  sections.push(`\n## Not installed — run \`${cli} add <name>\` and install before use\n`);
  for (const [name, pkg] of notInstalledAddables(facts)) {
    // Name the npm package too: Rule 0's card path is `@setu-ts/<package>`, and an add name such
    // as `queue` is not one (`queue-plugin` is), so a bare add name sent agents to a missing card.
    sections.push(`- \`${name}\` (\`@setu-ts/${pkg}\`) — ${PACKAGE_DATA.get(pkg)!.description}`);
  }
  return checkedSection(sections.join('\n') + `\n${BRIEF_END}`);
}

/** Workspace roots carry layout facts, with package guidance in each member. */
export function renderWorkspaceRoot(workspace: WorkspaceManifest, version: string): string {
  const profile = workspaceProfile(workspace.runtime);
  return checkedSection(
    [
      introduction(version),
      '## Commands\n',
      // The Deno runner starts each member's `start` task; the Node and Bun runners `start:dev`.
      `- \`${profile.runScript('dev')}\` — ${
        workspace.runtime === 'deno'
          ? "every member's `start` task (no file watching)"
          : "every member's `start:dev` loop"
      }, in dependency order`,
      `- \`${profile.testFromRoot}\` — every member's tests`,
      `- \`${profile.runScript('build')}\` — every member's image (\`setu workspace build\`)`,
      `- \`${profile.runScript('deploy')}\` — build, ship and roll out to Kubernetes; secrets in \`k8s/secrets/<member>/.env\``,
      `- \`cd apps/<member> && ${profile.runScript('start:dev')}\` — the member's development loop`,
      `- \`cd apps/<member> && ${profile.runScript('start')}\` — production entry`,
      '\n## Members\n',
      '| Member | Port | dependsOn | Devtool port | Brief |',
      '| --- | --- | --- | --- | --- |',
      ...workspace.members.map(
        (m) =>
          `| ${displayValue(m.name)} | ${displayValue(m.port)} | ${m.dependsOn?.map(displayValue).join(', ') || '—'} | ${displayValue(m.devtoolPort ?? '—')} | apps/${displayValue(m.name)}/AGENTS.md |`,
      ),
      `\nTransport: ${workspace.transport}; URL variable: ${getTransport(workspace.transport)?.connection?.variable ?? 'none'}. Endpoint override: ${displayValue(workspace.transportUrl ?? 'transport default')}.`,
      'Read the member’s own AGENTS.md before working in it.',
      BRIEF_END,
    ].join('\n'),
  );
}
