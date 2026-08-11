import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  BUILD_MATRIX,
  type DriftReport,
  EXCLUDED_EXAMPLES,
  isClean,
  missingTools,
  parseModes,
  pathCandidates,
  renderDrift,
  SKIP_EXIT_CODE,
} from '../scripts/check-deploy.ts';

const read = (path: string): string => Deno.readTextFileSync(path);

/**
 * Strips comment lines so an assertion is about EFFECTIVE configuration.
 *
 * Both these files discuss the wrong-but-plausible values in prose — `/health/live`, `/deno-dir`
 * — precisely because those are the traps. A raw substring match would read those explanations
 * as the config itself and fail on a correct file.
 */
const withoutComments = (source: string): string =>
  source
    // Helm comment blocks span multiple lines, so they must be removed as spans, not per line.
    .replace(/\{\{-?\s*\/\*[\s\S]*?\*\/\s*-?\}\}/g, '')
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');

describe('parseModes', () => {
  it('runs render, build and compose by default, but not the slow cluster check', () => {
    const modes = parseModes([]);
    expect(modes.render).toBe(true);
    expect(modes.build).toBe(true);
    expect(modes.compose).toBe(true);
    expect(modes.cluster).toBe(false);
    expect(modes.write).toBe(false);
  });

  it('runs exactly the named modes when any flag is given', () => {
    const modes = parseModes(['--render']);
    expect(modes.render).toBe(true);
    expect(modes.build).toBe(false);
    expect(modes.compose).toBe(false);
  });

  it('refuses an unknown flag rather than ignoring it', () => {
    // A typo that silently selected nothing would reduce the gate to a no-op that exits 0.
    expect(() => parseModes(['--rendre'])).toThrow(/Unknown flag/);
  });

  it('refuses --write on its own, because it selects no check', () => {
    expect(() => parseModes(['--write'])).toThrow(/selects no check/);
  });

  it('accepts --write as a modifier alongside --render', () => {
    const modes = parseModes(['--render', '--write']);
    expect(modes.render).toBe(true);
    expect(modes.write).toBe(true);
  });
});

describe('renderDrift', () => {
  const map = (entries: Record<string, string>): Map<string, string> =>
    new Map(Object.entries(entries));

  it('reports no difference for identical sets', () => {
    const report = renderDrift(map({ 'a.yaml': 'x' }), map({ 'a.yaml': 'x' }));
    expect(isClean(report)).toBe(true);
  });

  it('names a file whose content differs', () => {
    const report = renderDrift(map({ 'a.yaml': 'new' }), map({ 'a.yaml': 'old' }));
    expect(report.changed).toEqual(['a.yaml']);
    expect(isClean(report)).toBe(false);
  });

  it('names a rendered file that is not committed', () => {
    const report = renderDrift(map({ 'a.yaml': 'x', 'b.yaml': 'y' }), map({ 'a.yaml': 'x' }));
    expect(report.added).toEqual(['b.yaml']);
  });

  it('names a committed file that is no longer rendered', () => {
    const report = renderDrift(map({ 'a.yaml': 'x' }), map({ 'a.yaml': 'x', 'stale.yaml': 'z' }));
    expect(report.removed).toEqual(['stale.yaml']);
  });

  it('treats an EMPTY render against a non-empty committed set as drift, not as clean', () => {
    // Guards the vacuous pass: a `helm template` that silently produced nothing must fail the
    // gate rather than reporting that everything matches.
    const report = renderDrift(new Map(), map({ 'a.yaml': 'x', 'b.yaml': 'y' }));
    expect(isClean(report)).toBe(false);
    expect(report.removed).toEqual(['a.yaml', 'b.yaml']);
  });

  it('sorts each list so the report is stable', () => {
    const report: DriftReport = renderDrift(
      map({ 'z.yaml': '1', 'a.yaml': '1' }),
      new Map(),
    );
    expect(report.added).toEqual(['a.yaml', 'z.yaml']);
  });
});

describe('missingTools', () => {
  it('returns nothing when every required tool is present', () => {
    expect(missingTools(['docker', 'helm'], ['docker', 'helm', 'kind'])).toEqual([]);
  });

  it('names each absent tool so the skip message can say which', () => {
    expect(missingTools(['docker', 'helm', 'kind'], ['docker'])).toEqual(['helm', 'kind']);
  });
});

describe('pathCandidates', () => {
  it('expands PATH entries in order', () => {
    expect(pathCandidates('helm', '/usr/bin:/opt/bin')).toEqual([
      '/usr/bin/helm',
      '/opt/bin/helm',
    ]);
  });

  it('tolerates a trailing slash on a PATH entry', () => {
    expect(pathCandidates('kind', '/usr/local/bin/')).toEqual(['/usr/local/bin/kind']);
  });

  it('ignores empty PATH entries rather than probing the filesystem root', () => {
    expect(pathCandidates('kubectl', '/usr/bin::')).toEqual(['/usr/bin/kubectl']);
  });

  it('yields no candidate for an empty PATH', () => {
    // Presence is resolved by LOOKING for the binary, not by running it with a guessed version
    // flag: `helm --version` and `kubectl --version` both exit 1, and probing with the wrong
    // flag reports an installed tool as missing — a false skip, a gate that checked nothing.
    expect(pathCandidates('docker', '')).toEqual([]);
  });
});

describe('build matrix', () => {
  it('covers the four examples chosen for distinct build properties', () => {
    expect(BUILD_MATRIX.map((target) => target.app)).toEqual([
      'minimal',
      'rest-api',
      'realtime',
      'compiled-binary',
    ]);
  });

  it('builds the compiled example through the distroless Dockerfile', () => {
    const compiled = BUILD_MATRIX.find((target) => target.app === 'compiled-binary');
    expect(compiled?.dockerfile).toBe('docker/Dockerfile.compiled');
  });

  it('names every excluded example WITH a reason', () => {
    // An exclusion without a reason is indistinguishable from an oversight.
    expect(EXCLUDED_EXAMPLES.length).toBeGreaterThan(0);
    for (const excluded of EXCLUDED_EXAMPLES) {
      expect(excluded.reason.trim().length).toBeGreaterThan(20);
      expect(['unsupported', 'redundant']).toContain(excluded.kind);
    }
  });

  it('keeps cloudflare excluded as UNSUPPORTED, not merely redundant', () => {
    // A Worker deploys with `wrangler deploy` and has no listen(); the distinction matters
    // because a redundant example could later be added to the matrix and this one cannot.
    const cloudflare = EXCLUDED_EXAMPLES.find((excluded) => excluded.app === 'cloudflare');
    expect(cloudflare?.kind).toBe('unsupported');
  });

  it('accounts for every example directory as either built or excluded', () => {
    // The real guard against an example silently falling out of coverage: a new apps/ directory
    // must be classified deliberately.
    const directories: string[] = [];
    for (const entry of Deno.readDirSync('apps')) {
      if (entry.isDirectory) directories.push(entry.name);
    }
    const classified = new Set([
      ...BUILD_MATRIX.map((target) => target.app),
      ...EXCLUDED_EXAMPLES.map((excluded) => excluded.app),
    ]);
    const unclassified = directories.filter((name) => !classified.has(name));
    expect(unclassified).toEqual([]);
    expect(directories.length).toBeGreaterThan(0);
  });

  it('reserves the same skip exit code as the apps gate', () => {
    expect(SKIP_EXIT_CODE).toBe(77);
  });
});

describe('Dockerfiles', () => {
  const runtime = read('docker/Dockerfile');
  const compiled = read('docker/Dockerfile.compiled');

  it('pins the SAME Deno version in both, so a bump is a one-line change', () => {
    const version = (source: string): string | undefined =>
      source.match(/ARG DENO_VERSION=([\d.]+)/)?.[1];
    expect(version(runtime)).toBeDefined();
    expect(version(runtime)).toBe(version(compiled));
  });

  it('pins a Deno version rather than a floating tag', () => {
    // A floating tag makes an "unsupported lockfile version" failure arrive on an unrelated day.
    expect(runtime).not.toMatch(/FROM denoland\/deno:(alpine|latest)\s*$/m);
  });

  it('copies the workspace root BEFORE packages, which resolution requires', () => {
    // Without deno.json the build fails: an example maps only its direct dependencies, so
    // @setu-ts/common resolves against JSR instead of the local workspace member.
    const rootCopy = runtime.indexOf('COPY deno.json');
    const packagesCopy = runtime.indexOf('COPY packages');
    expect(rootCopy).toBeGreaterThan(-1);
    expect(packagesCopy).toBeGreaterThan(rootCopy);
  });

  it('builds the compiled binary on a glibc base, since distroless/cc is glibc', () => {
    // An alpine build stage links against musl and the binary will not run on distroless/cc.
    expect(compiled).toMatch(/FROM denoland\/deno:\$\{DENO_VERSION\} AS build/);
    expect(compiled).toContain('gcr.io/distroless/cc-debian12');
  });

  it('declares a NUMERIC non-root user in both images', () => {
    // Kubernetes' runAsNonRoot refuses an image whose user is a name:
    //   container has runAsNonRoot and image has non-numeric user (deno),
    //   cannot verify user is non-root
    // Docker resolves the name from /etc/passwd and runs it happily, so a named USER fails ONLY
    // under Kubernetes — which is why this is asserted here rather than discovered on a cluster.
    const user = (source: string): string | undefined => source.match(/^USER (\S+)$/m)?.[1];
    for (const source of [runtime, compiled]) {
      const declared = user(source);
      expect(declared).toBeDefined();
      expect(declared).toMatch(/^\d+:\d+$/);
      expect(declared).not.toBe('0:0');
    }
  });
});

describe('chart', () => {
  const values = read('k8s/chart/values.yaml');
  const valuesConfig = withoutComments(values);
  const deployment = read('k8s/chart/templates/deployment.yaml');
  const deploymentConfig = withoutComments(deployment);
  const rbac = read('k8s/chart/templates/rbac.yaml');

  it('defaults the probes to the paths HealthPlugin actually registers', () => {
    // HealthPlugin registers /health, /live and /ready. `/health/live` — the intuitive guess —
    // 404s, and a 404 liveness probe restart-loops a healthy pod.
    expect(valuesConfig).toMatch(/^\s*live:\s*\/live$/m);
    expect(valuesConfig).toMatch(/^\s*ready:\s*\/ready$/m);
    expect(valuesConfig).not.toContain('/health/live');
    expect(valuesConfig).not.toContain('/health/ready');
  });

  it('does NOT mount a volume over /deno-dir, which would mask the build-time module cache', () => {
    // Verified: with /deno-dir masked the container re-resolves from jsr.io at startup and dies
    // with "JSR package manifest for '@hono/hono' failed to load".
    expect(deploymentConfig).not.toContain('/deno-dir');
  });

  it('grants exactly the endpointslice access the kubernetes discovery provider requests', () => {
    expect(rbac).toContain('discovery.k8s.io');
    expect(rbac).toContain('endpointslices');
    expect(rbac).toMatch(/verbs:.*'list'/);
    expect(rbac).toMatch(/verbs:.*'watch'/);
  });

  it('keeps the discovery RBAC gated off by default, for least privilege', () => {
    expect(valuesConfig).toMatch(/serviceDiscovery:\s*\n\s*enabled:\s*false/);
  });

  it('declares a minimum Kubernetes version for the preStop sleep action', () => {
    // lifecycle.preStop.sleep is beta/default-on only from 1.30. A 1.28 API server REJECTS the
    // Deployment outright (verified on a real 1.28 cluster) and 1.29 accepts the field while the
    // action stays inert behind a gate, silently removing the drain window.
    const chart = read('k8s/chart/Chart.yaml');
    expect(chart).toMatch(/kubeVersion:\s*'>=1\.30/);
  });

  it('guards the inlined podSecurityContext so an empty map cannot break the render', () => {
    // A bare toYaml inlined into an existing mapping emits `{}` mid-mapping when the value is
    // nulled, and helm fails with an unhelpful "could not find expected ':'".
    expect(deployment).toMatch(/\{\{-\s*with\s+\.Values\.podSecurityContext\s*\}\}/);
  });

  it('keeps automountServiceAccountToken tied to the discovery gate', () => {
    // The provider reads its bearer token from the projected volume, so automounting must stay
    // on exactly when discovery is enabled.
    expect(deployment).toContain(
      'automountServiceAccountToken: {{ .Values.serviceDiscovery.enabled }}',
    );
  });
});

describe('skip contract', () => {
  it('exits 77 — not 1 — when a required tool is absent', async () => {
    // The module doc promises SKIP_EXIT_CODE for any mode whose tooling is absent. Only the
    // cluster mode honoured it; render/build/compose exited 1, so a contributor without helm got
    // a hard FAILED and CI could not tell "tool missing" from "gate genuinely failed".
    //
    // PATH is narrowed to Deno's own directory so `helm` cannot be found while `deno` still can.
    const denoDir = Deno.execPath().replace(/\/[^/]+$/, '');
    const result = await new Deno.Command(Deno.execPath(), {
      args: [
        'run',
        '--allow-read',
        '--allow-write',
        '--allow-run',
        '--allow-env',
        'scripts/check-deploy.ts',
        '--render',
      ],
      env: { PATH: denoDir },
      clearEnv: true,
      stdout: 'piped',
      stderr: 'piped',
    }).output();

    expect(result.code).toBe(SKIP_EXIT_CODE);
  });
});

describe('graceful shutdown in the containerized examples', () => {
  const MATRIX_ENTRY_POINTS = [
    'apps/minimal/main.ts',
    'apps/rest-api/main.ts',
    'apps/realtime/main.ts',
    'apps/compiled-binary/main.ts',
  ];

  it('every containerized example installs a SIGTERM handler', () => {
    // Without one, Deno's default action ends the process immediately (measured: 144 ms, exit
    // 143) and app.stop() never runs, making terminationGracePeriodSeconds decorative.
    for (const path of MATRIX_ENTRY_POINTS) {
      const source = read(path);
      expect(source).toContain('addSignalListener');
      expect(source).toContain('SIGTERM');
      expect(source).toContain('app.stop()');
    }
  });

  it('handles a REJECTING stop() rather than leaving an unhandled rejection', () => {
    // A rejecting onShutdown hook makes stop() reject. Verified against a real app: without
    // .catch the process dies with "Uncaught (in promise)" and Deno.exit(0) never runs.
    for (const path of MATRIX_ENTRY_POINTS) {
      expect(read(path)).toMatch(/app\.stop\(\)[\s\S]{0,300}\.catch\(/);
    }
  });
});

describe('rendered manifests', () => {
  const deployment = read('k8s/manifests/deployment.yaml');

  it('references an image whose application actually serves the probe paths', () => {
    // apps/minimal imports kernel + runtime only and serves a single `/` route, so a Deployment
    // of it would never pass readiness. rest-api reaches HealthPlugin through rest-starter.
    expect(deployment).toContain('setu/rest-api');
  });

  it('carries the probe paths through to the rendered object', () => {
    expect(deployment).toContain('path: /live');
    expect(deployment).toContain('path: /ready');
  });

  it('sets a termination grace period and a shorter preStop delay', () => {
    const grace = Number(deployment.match(/terminationGracePeriodSeconds:\s*(\d+)/)?.[1]);
    const preStop = Number(deployment.match(/seconds:\s*(\d+)/)?.[1]);
    expect(grace).toBeGreaterThan(0);
    expect(preStop).toBeLessThan(grace);
  });
});
