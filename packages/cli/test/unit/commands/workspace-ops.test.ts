import { describe, expect, it } from 'vitest';

import { createFakeFs } from '../../fixtures/fake-fs.ts';
import { parseArgs } from '../../../src/args.ts';
import { runWorkspaceCommand } from '../../../src/commands/workspace.ts';
import type { CommandRunner, RunCommandResult } from '../../../src/utils/run-command.ts';
import { workspaceK8sFiles } from '../../../src/workspace/k8s.ts';
import {
  renderWorkspaceManifest,
  WORKSPACE_MANIFEST,
  WORKSPACE_VERSION,
  type WorkspaceManifest,
  type WorkspaceMember,
} from '../../../src/workspace/manifest.ts';
import { transportSpec } from '../../../src/workspace/transport.ts';

/** One recorded external command. */
interface ICall {
  readonly command: string;
  readonly args: readonly string[];
  readonly input?: string;
  readonly stream?: boolean;
  readonly env?: Readonly<Record<string, string>>;
  readonly unsetPrefixes?: readonly string[];
}

type Responder = (call: ICall) => Partial<RunCommandResult> | undefined;

const SECRET = 'not-a-real-secret-4f9a';

function manifestOf(
  members: readonly WorkspaceMember[],
  runtime: WorkspaceManifest['runtime'] = 'node',
): WorkspaceManifest {
  return { version: WORKSPACE_VERSION, runtime, basePort: 3000, transport: 'redis', members };
}

/**
 * A workspace on disk plus a recording runner. Default responses: git reports commit `abc1234`
 * on a clean tree, the values file is untracked, the context is `kind-dev`, and everything else
 * succeeds.
 */
function harness(
  options: {
    readonly members?: readonly WorkspaceMember[];
    readonly runtime?: WorkspaceManifest['runtime'];
    readonly files?: Readonly<Record<string, string>>;
    readonly omit?: readonly string[];
    readonly respond?: Responder;
    readonly runner?: false;
    readonly root?: string;
  } = {},
) {
  const root = options.root ?? '/ws';
  const members = options.members ?? [
    { name: 'orders', port: 3000 },
    { name: 'portal', port: 3001 },
  ];
  const manifest = manifestOf(members, options.runtime);
  const k8s = workspaceK8sFiles(manifest, transportSpec('redis'));
  const lockfile =
    options.runtime === 'deno'
      ? 'deno.lock'
      : options.runtime === 'bun'
        ? 'bun.lock'
        : 'package-lock.json';
  const files: Record<string, string> = {
    [`/ws/${WORKSPACE_MANIFEST}`]: renderWorkspaceManifest(manifest),
    [`/ws/${lockfile}`]: '{}',
    ...Object.fromEntries(k8s.map((file) => [`/ws/${file.path}`, file.contents])),
    ...Object.fromEntries(members.map((member) => [`/ws/apps/${member.name}/.setu-member`, ''])),
    '/ws/apps/portal/.env.example': '# comment\nTRUSTED_PROXIES=\nSESSION_SECRET=\nREDIS_URL=\n',
    '/ws/k8s/secrets/portal/.env': `TRUSTED_PROXIES=\nSESSION_SECRET="${SECRET}"\n`,
    ...options.files,
  };
  for (const path of options.omit ?? []) delete files[path];
  const fs = createFakeFs(
    Object.fromEntries(
      Object.entries(files).map(([path, contents]) => [
        path.replace(/^\/ws\//, `${root}/`),
        contents,
      ]),
    ),
  );
  const calls: ICall[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const runner: CommandRunner = (command, args, opts) => {
    const call: ICall = {
      command,
      args,
      ...(opts.input === undefined ? {} : { input: opts.input }),
      ...(opts.stream === undefined ? {} : { stream: opts.stream }),
      ...(opts.env === undefined ? {} : { env: opts.env }),
      ...(opts.unsetPrefixes === undefined ? {} : { unsetPrefixes: opts.unsetPrefixes }),
    };
    calls.push(call);
    const custom = options.respond?.(call);
    const fallback = (): Partial<RunCommandResult> => {
      const line = `${command} ${args.join(' ')}`;
      if (line === 'git rev-parse --short HEAD') return { stdout: 'abc1234\n' };
      if (line === 'git rev-parse --is-inside-work-tree') return { stdout: 'true\n' };
      if (line === 'git status --porcelain') return { stdout: '' };
      if (line.startsWith('git ls-files')) return { code: 1 };
      if (line === 'kubectl config current-context') return { stdout: 'kind-dev\n' };
      // A first deploy: no Secret yet, the apply creates resourceVersion 1, no Deployments.
      if (args.includes('get') && args.includes('secret')) return { stdout: '' };
      if (args.includes('--server-side')) return { stdout: '1' };
      if (args.includes('deployments')) return { stdout: '' };
      // Like the cluster: a Deployment's pod template carries what the last members.yaml apply
      // stamped into that member's document.
      if (args.includes('jsonpath={.spec.template.metadata.annotations}')) {
        const member = args
          .find((arg) => arg.startsWith('deployment/'))!
          .slice('deployment/'.length);
        const applied = [...calls]
          .reverse()
          .find((c) => c.input?.includes('kind: Deployment') === true);
        const doc = applied?.input
          ?.split(/^---$/m)
          .find(
            (d) => d.includes('kind: Deployment') && new RegExp(`^  name: ${member}$`, 'm').test(d),
          );
        const version = /setu-ts\.dev\/secret-version: '([^']*)'/.exec(doc ?? '')?.[1] ?? '';
        return { stdout: JSON.stringify({ 'setu-ts.dev/secret-version': version }) };
      }
      return {};
    };
    const result = custom ?? fallback();
    return Promise.resolve({ code: 0, stdout: '', stderr: '', ...result });
  };
  return {
    fs,
    calls,
    out,
    err,
    line: (call: ICall) => `${call.command} ${call.args.join(' ')}`,
    run: (argv: readonly string[]) =>
      runWorkspaceCommand(parseArgs(argv), {
        fs,
        cwd: root,
        log: (m) => out.push(m),
        error: (m) => err.push(m),
        now: () => Date.UTC(2026, 9, 29, 7, 5, 9),
        ...(options.runner === false ? {} : { runCommand: runner }),
      }),
  };
}

describe('setu workspace build', () => {
  it('builds every member from the root with the commit tag and the npmrc secret', async () => {
    const h = harness();
    expect(await h.run(['build'])).toBe(0);
    const builds = h.calls.filter((call) => call.command === 'docker');
    expect(builds.map(h.line)).toEqual([
      'docker build -f docker/Dockerfile --build-arg MEMBER=orders --secret id=npmrc,env=NPMRC -t orders:abc1234 .',
      'docker build -f docker/Dockerfile --build-arg MEMBER=portal --secret id=npmrc,env=NPMRC -t portal:abc1234 .',
    ]);
    expect(builds.every((call) => call.stream === true)).toBe(true);
    expect(h.out).toContain('  portal:abc1234');
  });

  it('prefixes a registry, dropping one trailing slash, and never pushes', async () => {
    for (const ok of ['localhost:5000', 'registry.example.com/team/sub-team', 'r.io/a_b']) {
      expect(await harness().run(['build', '--registry', ok, '--dry-run']), ok).toBe(0);
    }
    for (const registry of ['ghcr.io/acme', 'ghcr.io/acme/']) {
      const h = harness();
      expect(await h.run(['build', '--registry', registry, '--tag', 'v1'])).toBe(0);
      expect(h.calls.filter((c) => c.command === 'docker').map((c) => c.args.at(-2))).toEqual([
        'ghcr.io/acme/orders:v1',
        'ghcr.io/acme/portal:v1',
      ]);
      expect(h.calls.some((c) => c.args[0] === 'push')).toBe(false);
      // An explicit tag reads no git state.
      expect(h.calls.some((c) => c.command === 'git')).toBe(false);
    }
  });

  it('tags a dirty tree -dirty, and uses a UTC timestamp outside a repository', async () => {
    const dirty = harness({
      respond: (c) => (c.args[0] === 'status' ? { stdout: ' M main.ts\n' } : undefined),
    });
    expect(await dirty.run(['build'])).toBe(0);
    expect(dirty.calls.find((c) => c.command === 'docker')?.args.at(-2)).toBe(
      'orders:abc1234-dirty-20261029070509',
    );

    const norepo = harness({
      respond: (c) =>
        c.args[0] === 'rev-parse' ? { code: 128, stderr: 'not a git repository' } : undefined,
    });
    expect(await norepo.run(['build'])).toBe(0);
    expect(norepo.calls.find((c) => c.command === 'docker')?.args.at(-2)).toBe(
      'orders:build-20261029070509',
    );
  });

  it('stops at the first failing member and names it; a missing docker is named', async () => {
    const h = harness({
      respond: (c) =>
        c.command === 'docker' && c.args.includes('MEMBER=orders') ? { code: 2 } : undefined,
    });
    expect(await h.run(['build'])).toBe(1);
    expect(h.calls.filter((c) => c.command === 'docker')).toHaveLength(1);
    expect(h.err.join('\n')).toContain('Building orders failed (exit 2).');

    const missing = harness({
      respond: (c) => (c.command === 'docker' ? { code: 127 } : undefined),
    });
    expect(await missing.run(['build'])).toBe(1);
    expect(missing.err.join('\n')).toContain('docker is not installed or not on PATH');
  });

  it('forwards every --build-arg and --network to each build, in order', async () => {
    const h = harness();
    expect(
      await h.run([
        'build',
        '--build-arg',
        'NPM_CONFIG_REGISTRY=http://127.0.0.1:4873/',
        '--build-arg=EXTRA=1',
        '--network',
        'host',
      ]),
    ).toBe(0);
    const first = h.calls.find((c) => c.command === 'docker')!;
    expect(h.line(first)).toBe(
      'docker build -f docker/Dockerfile --build-arg NPM_CONFIG_REGISTRY=http://127.0.0.1:4873/ ' +
        '--build-arg EXTRA=1 --network host --build-arg MEMBER=orders ' +
        '--secret id=npmrc,env=NPMRC -t orders:abc1234 .',
    );
  });

  it('prints the builds on --dry-run and runs none', async () => {
    const h = harness();
    expect(await h.run(['build', '--dry-run'])).toBe(0);
    expect(h.calls.some((c) => c.command === 'docker')).toBe(false);
    expect(h.out.join('\n')).toContain('would run: docker build');
  });

  it('refuses a workspace it cannot build, before running anything', async () => {
    const lockless = harness({ omit: ['/ws/package-lock.json'] });
    expect(await lockless.run(['build'])).toBe(1);
    expect(lockless.err.join('\n')).toContain('package-lock.json is missing');
    expect(lockless.err.join('\n')).toContain('npm install');

    for (const [runtime, lockfile, install] of [
      ['deno', 'deno.lock', 'deno install'],
      ['bun', 'bun.lock', 'bun install'],
    ] as const) {
      const h = harness({ runtime, omit: [`/ws/${lockfile}`] });
      expect(await h.run(['build'])).toBe(1);
      expect(h.err.join('\n')).toContain(`${lockfile} is missing`);
      expect(h.err.join('\n')).toContain(install);
    }

    const empty = harness({ members: [] });
    expect(await empty.run(['build'])).toBe(1);
    expect(empty.err.join('\n')).toContain('has no members yet');

    const notWorkspace = harness({ omit: [`/ws/${WORKSPACE_MANIFEST}`] });
    expect(await notWorkspace.run(['build'])).toBe(1);
    expect(notWorkspace.err.join('\n')).toContain('not a Setu workspace');

    const vanished = harness({
      omit: ['/ws/apps/portal/.setu-member', '/ws/apps/portal/.env.example'],
    });
    expect(await vanished.run(['build'])).toBe(1);
    expect(vanished.err.join('\n')).toContain('apps/portal');

    const badName = harness({ members: [{ name: 'Orders_V2', port: 3000 }] });
    expect(await badName.run(['build'])).toBe(1);
    expect(badName.err.join('\n')).toContain('is not a valid image and Kubernetes name');
    expect(badName.calls).toEqual([]);

    const hostless = harness({ runner: false });
    expect(await hostless.run(['build'])).toBe(1);
    expect(hostless.err.join('\n')).toContain('cannot run docker');
  });

  it('refuses usage errors with exit 2', async () => {
    for (const argv of [
      ['build', '--tag', 'a/b'],
      ['build', '--tag=-bad'],
      ['build', '--tag'],
      ['build', '--registry='],
      ['build', '--registry', 'ghcr.io/acme\nimage: evil'],
      ['build', '--registry', 'GHCR.io'],
      ['build', '--dir'],
      ['build', '--build-arg', 'NOEQUALS'],
      ['build', '--build-arg'],
      ['build', '--network'],
    ]) {
      const h = harness();
      expect(await h.run(argv), argv.join(' ')).toBe(2);
      expect(h.calls).toEqual([]);
    }
  });

  it('uses the epoch when the caller supplies no clock', async () => {
    const h = harness({
      respond: (c) => (c.args[0] === 'rev-parse' ? { code: 128 } : undefined),
    });
    const fs = h.fs;
    const calls: string[] = [];
    expect(
      await runWorkspaceCommand(parseArgs(['build']), {
        fs,
        cwd: '/ws',
        log: () => {},
        error: () => {},
        runCommand: (command, args) => {
          calls.push(`${command} ${args.join(' ')}`);
          return Promise.resolve({ code: command === 'git' ? 128 : 0, stdout: '', stderr: '' });
        },
      }),
    ).toBe(0);
    expect(calls).toContain(
      'docker build -f docker/Dockerfile --build-arg MEMBER=orders --secret id=npmrc,env=NPMRC -t orders:build-19700101000000 .',
    );
  });

  it('prints its help', async () => {
    const h = harness();
    expect(await h.run(['build', '--help'])).toBe(0);
    expect(h.out[0]).toContain('workspace build');
  });
});

describe('setu workspace deploy', () => {
  it('builds, loads into kind, applies namespace, Secret and manifest, then waits', async () => {
    const h = harness();
    expect(await h.run(['deploy'])).toBe(0);
    const lines = h.calls.map(h.line);
    expect(lines).toEqual([
      'git rev-parse --short HEAD',
      'git status --porcelain',
      'kubectl config current-context',
      'git rev-parse --is-inside-work-tree',
      'git ls-files --error-unmatch k8s/secrets/portal/.env',
      expect.stringContaining('docker build'),
      expect.stringContaining('docker build'),
      'kind load docker-image orders:abc1234 --name dev',
      'kind load docker-image portal:abc1234 --name dev',
      'kubectl --context kind-dev apply -f -',
      'kubectl --context kind-dev -n ws get secret portal-env --ignore-not-found -o jsonpath={.metadata.resourceVersion}',
      'kubectl --context kind-dev apply --server-side --field-manager=setu --force-conflicts -o jsonpath={.metadata.resourceVersion} -f -',
      'kubectl --context kind-dev apply -f -',
      'kubectl --context kind-dev -n ws get deployment/portal -o jsonpath={.spec.template.metadata.annotations}',
      'kubectl --context kind-dev -n ws rollout status deployment/orders --timeout=120s',
      'kubectl --context kind-dev -n ws rollout status deployment/portal --timeout=120s',
    ]);
    const [namespace, secret, members] = h.calls.filter((c) => c.input !== undefined);
    expect(namespace?.input).toContain('kind: Namespace\nmetadata:\n  name: ws\n');
    // The Secret carries base64 data only: no stringData, no value in the clear.
    expect(secret?.input).toContain('name: portal-env');
    expect(secret?.input).toContain(`SESSION_SECRET: ${btoa(SECRET)}`);
    expect(secret?.input).toContain("TRUSTED_PROXIES: ''\n");
    expect(secret?.input).not.toContain('stringData');
    expect(secret?.input).not.toContain(SECRET);
    // REDIS_URL is declared but the generated env sets it, so it is not demanded.
    expect(secret?.input).not.toContain('REDIS_URL');
    expect(members?.input).toContain('image: portal:abc1234');
    // The Secret's version is stamped into portal's pod template only (re-audit N2).
    expect(members?.input?.match(/setu-ts\.dev\/secret-version: '1'/g)).toHaveLength(1);
    expect(members?.input).toContain("setu-ts.dev/secret-version: ''");
    expect(members?.input).not.toContain('${NAMESPACE}');
    expect(members?.input).toContain('namespace: ws');
    // No value ever reaches an argument list or the output.
    for (const call of h.calls) expect(call.args.join(' ')).not.toContain(SECRET);
    expect([...h.out, ...h.err].join('\n')).not.toContain(SECRET);
    expect(h.out.join('\n')).toContain('applied Secret portal-env (2 key(s))');
  });

  it('pushes to a registry on any other context, and requires one there', async () => {
    const other = {
      respond: (c: ICall) => (c.args[1] === 'current-context' ? { stdout: 'prod\n' } : undefined),
    };
    const refused = harness(other);
    expect(await refused.run(['deploy'])).toBe(2);
    expect(refused.err.join('\n')).toContain('pass --registry <prefix>');
    expect(refused.calls.some((c) => c.command === 'docker')).toBe(false);

    const pushed = harness(other);
    expect(await pushed.run(['deploy', '--registry', 'ghcr.io/acme'])).toBe(0);
    const lines = pushed.calls.map(pushed.line);
    expect(lines).toContain('docker push ghcr.io/acme/orders:abc1234');
    expect(lines.some((line) => line.startsWith('kind'))).toBe(false);
    expect(lines).toContain('kubectl --context prod apply -f -');
  });

  it('honours --context, --namespace and --timeout everywhere', async () => {
    const h = harness();
    expect(
      await h.run(['deploy', '--context', 'kind-ci', '--namespace', 'shop', '--timeout', '5m']),
    ).toBe(0);
    const lines = h.calls.map(h.line);
    expect(lines).not.toContain('kubectl config current-context');
    expect(lines).toContain('kind load docker-image orders:abc1234 --name ci');
    expect(lines).toContain(
      'kubectl --context kind-ci -n shop rollout status deployment/portal --timeout=5m',
    );
    expect(h.calls.find((c) => c.input?.includes('kind: Secret') === true)?.input).toContain(
      'namespace: shop',
    );
  });

  it('refuses before building when a declared value is missing, naming every one', async () => {
    const h = harness({
      files: { '/ws/k8s/secrets/portal/.env': 'TRUSTED_PROXIES=\n' },
    });
    expect(await h.run(['deploy'])).toBe(1);
    expect(h.err.join('\n')).toContain('portal needs SESSION_SECRET in k8s/secrets/portal/.env.');
    expect(h.calls.some((c) => c.command === 'docker' || c.input !== undefined)).toBe(false);

    const absent = harness({ omit: ['/ws/k8s/secrets/portal/.env'] });
    expect(await absent.run(['deploy'])).toBe(1);
    expect(absent.err.join('\n')).toContain(
      'portal needs TRUSTED_PROXIES, SESSION_SECRET in k8s/secrets/portal/.env (the file does not exist).',
    );
  });

  it('refuses a tracked values file and a malformed one, without showing a value', async () => {
    const tracked = harness({
      respond: (c) => (c.args[0] === 'ls-files' ? { code: 0 } : undefined),
    });
    expect(await tracked.run(['deploy'])).toBe(1);
    expect(tracked.err.join('\n')).toContain('is tracked by git');

    const malformed = harness({
      files: { '/ws/k8s/secrets/portal/.env': `SESSION_SECRET="${SECRET}\n` },
    });
    expect(await malformed.run(['deploy'])).toBe(1);
    expect(malformed.err.join('\n')).toContain('k8s/secrets/portal/.env: Unterminated');
    expect(malformed.err.join('\n')).not.toContain(SECRET);

    const badExample = harness({ files: { '/ws/apps/portal/.env.example': 'NOEQUALS\n' } });
    expect(await badExample.run(['deploy'])).toBe(1);
    expect(badExample.err.join('\n')).toContain('apps/portal/.env.example: Malformed');
  });

  it('applies a Secret for a values file even when nothing is declared, and none without one', async () => {
    const h = harness({
      omit: ['/ws/apps/portal/.env.example', '/ws/k8s/secrets/portal/.env'],
      files: { '/ws/k8s/secrets/orders/.env': 'EXTRA=1\n' },
    });
    expect(await h.run(['deploy'])).toBe(0);
    const secrets = h.calls.filter((c) => c.input?.includes('kind: Secret') === true);
    expect(secrets.map((c) => /name: (\S+-env)/.exec(c.input!)?.[1])).toEqual(['orders-env']);
  });

  it('refuses a pre-M122 manifest that does not read the Secret, printing the lines to add', async () => {
    const h = harness();
    const yaml = h.fs.read('/ws/k8s/members.yaml');
    const old = harness({
      files: { '/ws/k8s/members.yaml': yaml.replace(/ {10}envFrom:\n(?: {12,}.*\n){3}/g, '') },
    });
    expect(await old.run(['deploy'])).toBe(1);
    const message = old.err.join('\n');
    expect(message).toContain('does not read portal-env');
    expect(message).toContain(
      'envFrom:\n            - secretRef:\n                name: portal-env',
    );
  });

  it('refuses a manifest whose image line or placeholders it cannot fill', async () => {
    const h = harness();
    const yaml = h.fs.read('/ws/k8s/members.yaml');
    const noImage = harness({
      files: {
        '/ws/k8s/members.yaml': yaml.replace('image: orders:dev', 'image: ghcr.io/me/orders:7'),
      },
    });
    expect(await noImage.run(['deploy'])).toBe(1);
    expect(noImage.err.join('\n')).toContain('has no `image: orders:dev` line');

    const extra = harness({ files: { '/ws/k8s/members.yaml': `${yaml}# \${REGION}\n` } });
    expect(await extra.run(['deploy'])).toBe(1);
    expect(extra.err.join('\n')).toContain('still contains ${REGION}');

    const missing = harness({ omit: ['/ws/k8s/members.yaml'] });
    expect(await missing.run(['deploy'])).toBe(1);
    expect(missing.err.join('\n')).toContain('k8s/members.yaml is missing');
  });

  it('reports a rollout that does not finish, with the commands to inspect it', async () => {
    const h = harness({
      respond: (c) => (c.args.includes('deployment/orders') ? { code: 1 } : undefined),
    });
    expect(await h.run(['deploy'])).toBe(1);
    const message = h.err.join('\n');
    expect(message).toContain('orders did not finish rolling out within 120s');
    expect(message).toContain('kubectl --context kind-dev -n ws logs deployment/orders');
    expect(
      h.calls.some((c) => c.args.includes('status') && c.args.includes('deployment/portal')),
    ).toBe(false);
  });

  it('reports failed ships and applies, redacting secret values from kubectl output', async () => {
    const ship = harness({ respond: (c) => (c.command === 'kind' ? { code: 1 } : undefined) });
    expect(await ship.run(['deploy'])).toBe(1);
    expect(ship.err.join('\n')).toContain('Shipping orders:abc1234 failed (exit 1).');

    // Overlapping and JSON-escaped forms defeated redaction (audit F3), so a Secret's stderr is
    // never shown at all.
    const apply = harness({
      files: { '/ws/k8s/secrets/portal/.env': `TRUSTED_PROXIES=not\nSESSION_SECRET="${SECRET}"\n` },
      respond: (c) =>
        c.args.includes('--server-side')
          ? {
              code: 1,
              stderr: `invalid "${SECRET}" ${JSON.stringify(SECRET)} ${btoa(SECRET)} not\n`,
            }
          : undefined,
    });
    expect(await apply.run(['deploy'])).toBe(1);
    const message = apply.err.join('\n');
    expect(message).toContain('Applying Secret portal-env (2 key(s)) failed (exit 1).');
    expect(message).toContain("kubectl's message is not shown for a Secret");
    expect(message).not.toContain(SECRET);
    expect(message).not.toContain(btoa(SECRET));
    expect(message).not.toContain('invalid');

    // Any other object's stderr is shown, so the operator can see why.
    const other = harness({
      respond: (c) =>
        c.input?.includes('kind: Namespace') === true
          ? { code: 1, stderr: 'forbidden: namespaces\n' }
          : undefined,
    });
    expect(await other.run(['deploy'])).toBe(1);
    expect(other.err.join('\n')).toContain('forbidden: namespaces');

    for (const failing of ['kind: Namespace', 'kind: Deployment']) {
      const h = harness({
        respond: (c) => (c.input?.includes(failing) === true ? { code: 1 } : undefined),
      });
      expect(await h.run(['deploy']), failing).toBe(1);
    }
  });

  it('reports a missing kubectl and an unset context', async () => {
    const missing = harness({
      respond: (c) => (c.command === 'kubectl' ? { code: 127 } : undefined),
    });
    expect(await missing.run(['deploy'])).toBe(1);
    expect(missing.err.join('\n')).toContain('kubectl is not installed or not on PATH');

    const unset = harness({
      respond: (c) => (c.args[1] === 'current-context' ? { code: 1, stdout: '' } : undefined),
    });
    expect(await unset.run(['deploy'])).toBe(1);
    expect(unset.err.join('\n')).toContain('Pass --context <name>');
  });

  it('rolls a member out by stamping its Secret version, idempotent across retries (F1, N2)', async () => {
    const versions = (after: string) =>
      harness({
        respond: (c) => {
          if (c.args.includes('get') && c.args.includes('secret')) return { stdout: '41' };
          if (c.args.includes('--server-side')) return { stdout: after };
          return undefined;
        },
      });
    const changed = versions('42');
    expect(await changed.run(['deploy'])).toBe(0);
    const applied = changed.calls.filter((c) => c.input?.includes('kind: Deployment') === true);
    expect(applied[0]?.input).toContain("setu-ts.dev/secret-version: '42'");
    // The template changes, so Kubernetes rolls out by itself: no explicit restart and no listing.
    expect(
      changed.calls.some((c) => c.args.includes('restart') || c.args.includes('deployments')),
    ).toBe(false);

    // A re-run after a failure part-way (version already 42) still writes 42; if the earlier apply
    // never landed, the template still changes.
    const rerun = versions('42');
    expect(await rerun.run(['deploy'])).toBe(0);
    expect(
      rerun.calls.find((c) => c.input?.includes('kind: Deployment') === true)?.input,
    ).toContain("setu-ts.dev/secret-version: '42'");
  });

  it('falls back to rollout restart for a members.yaml without the version slot', async () => {
    const base = harness();
    const old = base.fs
      .read('/ws/k8s/members.yaml')
      .replace(/^ +# Set by `setu workspace deploy`.*\n/gm, '')
      .replace(/^ +setu-ts\.dev\/secret-version: ''\n/gm, '');
    const rotate = (before: string, after: string, deployments: string) =>
      harness({
        files: { '/ws/k8s/members.yaml': old },
        respond: (c) => {
          if (c.args.includes('get') && c.args.includes('secret')) return { stdout: before };
          if (c.args.includes('--server-side')) return { stdout: after };
          if (c.args.includes('deployments')) return { stdout: deployments };
          return undefined;
        },
      });
    const changed = rotate('41', '42', 'deployment.apps/orders\ndeployment.apps/portal\n');
    expect(await changed.run(['deploy'])).toBe(0);
    const lines = changed.calls.map(changed.line);
    const restart = 'kubectl --context kind-dev -n ws rollout restart deployment/portal';
    expect(lines).toContain(restart);
    expect(lines.indexOf(restart)).toBeLessThan(
      lines.indexOf(
        'kubectl --context kind-dev -n ws rollout status deployment/portal --timeout=120s',
      ),
    );
    expect(lines.some((line) => line.includes('restart deployment/orders'))).toBe(false);
    expect(changed.out.join('\n')).toContain('restarted deployment/portal: its Secret changed');

    const same = rotate('42', '42', 'deployment.apps/portal\n');
    expect(await same.run(['deploy'])).toBe(0);
    expect(same.calls.some((c) => c.args.includes('restart'))).toBe(false);

    // A Deployment this apply creates already reads the new Secret: no restart.
    const first = rotate('', '7', '');
    expect(await first.run(['deploy'])).toBe(0);
    expect(first.calls.some((c) => c.args.includes('restart'))).toBe(false);

    for (const [match, label] of [
      [(c: ICall) => c.args.includes('deployments'), 'Listing Deployments'],
      [(c: ICall) => c.args.includes('restart'), 'Restarting portal for its changed Secret'],
    ] as const) {
      const h = harness({
        files: { '/ws/k8s/members.yaml': old },
        respond: (c) => {
          if (match(c)) return { code: 1, stderr: 'nope\n' };
          if (c.args.includes('get') && c.args.includes('secret')) return { stdout: '1' };
          if (c.args.includes('--server-side')) return { stdout: '2' };
          if (c.args.includes('deployments')) return { stdout: 'deployment.apps/portal\n' };
          return undefined;
        },
      });
      expect(await h.run(['deploy']), label).toBe(1);
      expect(h.err.join('\n')).toContain(`${label} failed (exit 1).`);
    }
  });

  it('refuses a resourceVersion it cannot stamp safely (audit 3, L3)', async () => {
    for (const version of ['', "1'\n        evil.example/x: 'y"]) {
      const h = harness({
        respond: (c) => (c.args.includes('--server-side') ? { stdout: version } : undefined),
      });
      expect(await h.run(['deploy']), JSON.stringify(version)).toBe(1);
      expect(h.err.join('\n')).toContain('unexpected resourceVersion for Secret portal-env');
      expect(h.calls.some((c) => c.input?.includes('kind: Deployment') === true)).toBe(false);
    }
  });

  it('restarts a member whose applied template does not carry its stamp (audit 4, A4-1)', async () => {
    for (const answer of [
      JSON.stringify({ 'setu-ts.dev/secret-version': '0' }),
      '',
      'not json',
      JSON.stringify(['x']),
    ]) {
      const h = harness({
        respond: (c) =>
          c.args.includes('jsonpath={.spec.template.metadata.annotations}')
            ? { stdout: answer }
            : undefined,
      });
      expect(await h.run(['deploy']), answer).toBe(0);
      expect(h.calls.map(h.line)).toContain(
        'kubectl --context kind-dev -n ws rollout restart deployment/portal',
      );
    }
    // A matching stamp needs no restart, and only stamped members are read back.
    const ok = harness();
    expect(await ok.run(['deploy'])).toBe(0);
    expect(ok.calls.some((c) => c.args.includes('restart'))).toBe(false);
    expect(
      ok.calls
        .filter((c) => c.args.includes('jsonpath={.spec.template.metadata.annotations}'))
        .map((c) => c.args.find((a) => a.startsWith('deployment/'))),
    ).toEqual(['deployment/portal']);

    const failed = harness({
      respond: (c) =>
        c.args.includes('jsonpath={.spec.template.metadata.annotations}')
          ? { code: 1, stderr: 'nope\n' }
          : undefined,
    });
    expect(await failed.run(['deploy'])).toBe(1);
    expect(failed.err.join('\n')).toContain('Reading deployment/portal failed (exit 1).');
  });

  it('reports a failed Secret read', async () => {
    const h = harness({
      respond: (c) =>
        c.args.includes('get') && c.args.includes('secret')
          ? { code: 1, stderr: 'nope\n' }
          : undefined,
    });
    expect(await h.run(['deploy'])).toBe(1);
    expect(h.err.join('\n')).toContain('Reading Secret portal-env failed (exit 1).');
  });

  it('checks a values file against git failing closed (audit F2)', async () => {
    const notRepo = harness({
      respond: (c) =>
        c.args[1] === '--is-inside-work-tree'
          ? {
              code: 128,
              stderr: 'fatal: not a git repository (or any of the parent directories): .git\n',
            }
          : undefined,
    });
    expect(await notRepo.run(['deploy'])).toBe(0);
    expect(notRepo.calls.some((c) => c.args[0] === 'ls-files')).toBe(false);

    // Every git call that is read for its message runs in the C locale.
    const plain = harness();
    expect(await plain.run(['deploy'])).toBe(0);
    for (const call of plain.calls.filter(
      (c) => c.args[0] === 'ls-files' || c.args[1] === '--is-inside-work-tree',
    )) {
      // Inherited GIT_DIR, GIT_INDEX_FILE and the like would aim git at another repository.
      expect(call.unsetPrefixes).toEqual(['GIT_']);
      // Discovery crosses filesystems, so a workspace mounted inside a repository is found (A4-2).
      expect(call.env).toEqual({ LC_ALL: 'C', GIT_DISCOVERY_ACROSS_FILESYSTEM: '1' });
    }

    const noGit = harness({
      respond: (c) => (c.args[1] === '--is-inside-work-tree' ? { code: 127 } : undefined),
    });
    expect(await noGit.run(['deploy', '--tag', 'v1'])).toBe(1);
    expect(noGit.err.join('\n')).toContain('git is not installed or not on PATH');

    // Every other answer fails closed (re-audit N1): a repository git declines to read, an
    // unexpected exit, and `false` from inside a bare repository's directory.
    for (const [answer, message] of [
      [
        { code: 128, stderr: "fatal: detected dubious ownership in repository at '/ws'\n" },
        'git could not inspect this workspace (exit 128: fatal: detected dubious ownership',
      ],
      [
        { code: 129, stderr: 'usage: git rev-parse\n' },
        'git could not inspect this workspace (exit 129',
      ],
      [{ code: 0, stdout: 'false\n' }, 'git does not report a work tree here ("false")'],
      // Stopping at a mount point is not "no repository" (audit 4, A4-2).
      [
        {
          code: 128,
          stderr: 'fatal: not a git repository (or any parent up to mount point /ws)\n',
        },
        'git could not inspect this workspace (exit 128',
      ],
      // GIT_DIR's own failure names that directory, not the parent search (audit 3, L1).
      [
        { code: 128, stderr: "fatal: not a git repository: '/nonexistent'\n" },
        'git could not inspect this workspace (exit 128',
      ],
    ] as const) {
      const h = harness({
        respond: (c) => (c.args[1] === '--is-inside-work-tree' ? answer : undefined),
      });
      expect(await h.run(['deploy']), message).toBe(1);
      expect(h.err.join('\n')).toContain(message);
      expect(h.calls.some((c) => c.command === 'docker')).toBe(false);
    }

    const odd = harness({ respond: (c) => (c.args[0] === 'ls-files' ? { code: 128 } : undefined) });
    expect(await odd.run(['deploy'])).toBe(1);
    expect(odd.err.join('\n')).toContain(
      'git could not say whether k8s/secrets/portal/.env is committed (exit 128)',
    );
  });

  it('prints the whole plan on --dry-run, key names only, and changes nothing', async () => {
    const h = harness();
    expect(await h.run(['deploy', '--dry-run'])).toBe(0);
    expect(h.calls.every((c) => c.command === 'git' || c.args[0] === 'config')).toBe(true);
    const text = h.out.join('\n');
    expect(text).toContain('Dry run: would deploy 2 member(s) to ws on kind-dev');
    expect(text).toContain('would run: kind load docker-image portal:abc1234 --name dev');
    expect(text).toContain('Secret portal-env with TRUSTED_PROXIES, SESSION_SECRET');
    expect(text).toContain('would wait: rollout of deployment/portal (timeout 120s)');
    expect(text).toContain('would roll out: each member whose Secret version changes');
    expect(text).not.toContain(SECRET);

    const pushed = harness({
      respond: (c) => (c.args[1] === 'current-context' ? { stdout: 'prod\n' } : undefined),
      files: { '/ws/k8s/secrets/orders/.env': '' },
    });
    expect(await pushed.run(['deploy', '--dry-run', '--registry', 'r.io'])).toBe(0);
    expect(pushed.out.join('\n')).toContain('would run: docker push r.io/orders:abc1234');
    expect(pushed.out.join('\n')).toContain('Secret orders-env with no keys');
  });

  it('refuses invalid deploy options with exit 2', async () => {
    for (const argv of [
      ['deploy', '--timeout', '120'],
      ['deploy', '--timeout', '0s'],
      ['deploy', '--namespace', 'Shop'],
      ['deploy', '--context'],
    ]) {
      const h = harness();
      expect(await h.run(argv), argv.join(' ')).toBe(2);
      expect(h.calls).toEqual([]);
    }
  });

  it('labels with the namespace when the directory name is not a label value', async () => {
    const h = harness({ root: '/my shop' });
    expect(await h.run(['deploy', '--namespace', 'shop'])).toBe(0);
    const members = h.calls.find((c) => c.input?.includes('kind: Deployment') === true)?.input;
    expect(members).toContain('app.kubernetes.io/part-of: shop');

    // And the directory name alone is refused as a namespace, naming --namespace.
    const unnamed = harness({ root: '/my shop' });
    expect(await unnamed.run(['deploy'])).toBe(2);
    expect(unnamed.err.join('\n')).toContain('Pass --namespace <name>');
  });

  it('prints its help', async () => {
    const h = harness();
    expect(await h.run(['deploy', '--help'])).toBe(0);
    expect(h.out[0]).toContain('workspace deploy');
  });
});
