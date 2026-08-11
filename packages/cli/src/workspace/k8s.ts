/**
 * The Kubernetes objects a generated workspace deploys with: a Deployment and a
 * Service per member.
 *
 * M39 owns this repository's own chart; nothing produced objects for a user's
 * project, which is the half of that boundary this closes. It is deliberately raw
 * YAML rather than a chart: a generated workspace has a known, small object set,
 * and a chart would add a templating layer over values the CLI already knows —
 * M39's chart exists because it renders for many examples and many value sets.
 *
 * **Four details are M39's cluster findings, not preferences.** Each one passed a
 * Docker run and failed against a real cluster:
 *
 * - `runAsNonRoot` REFUSES a non-numeric image user (`cannot verify user is
 *   non-root`), so the image's numeric UID is repeated here.
 * - An `emptyDir` over the module cache directory MASKS the cache baked at build
 *   time, and every pod then re-resolves from the network at startup — fatal in an
 *   air-gapped cluster. Only `/tmp` is mounted.
 * - Every object PINS its namespace; leaving it implicit is how a RoleBinding
 *   ends up granting nothing while applying cleanly.
 * - `terminationGracePeriodSeconds` is only real because the generated entry
 *   installs a SIGTERM handler. Without one the container dies from the signal in
 *   milliseconds and the window is decorative.
 *
 * The probes are `tcpSocket` rather than `/live` and `/ready`, and that is a
 * correctness choice: those paths exist only when the member registers
 * `HealthPlugin`, which depends on its template, and a generated HTTP probe
 * against a member that has none would fail readiness forever. A comment names the
 * upgrade.
 *
 * @module
 */

import type { GeneratedFile } from '../utils/file-writer.ts';
import { memberEnvironment } from './compose.ts';
import type { WorkspaceManifest } from './manifest.ts';
import type { TransportSpec } from './transport.ts';

/** Where the generated Kubernetes objects live, relative to the workspace root. */
export const K8S_DIR = 'k8s';

/**
 * The numeric uid the generated image runs as.
 *
 * Numeric, not `deno`: `runAsNonRoot` cannot verify a named user, and that fails
 * ONLY under Kubernetes — Docker resolves the name and runs it happily.
 */
const RUN_AS_USER = 1000;

/**
 * Renders the Deployment and Service for one member.
 *
 * @param name - The member's name, used for every object and selector
 * @param port - The port it binds
 * @param siblings - Every other member, whose host variables it carries
 * @param transport - The workspace's transport
 * @returns One YAML document pair
 */
function memberObjects(
  name: string,
  port: number,
  siblings: readonly WorkspaceManifest['members'][number][],
  transport: TransportSpec,
): string {
  const env = memberEnvironment(siblings, transport);
  const envBlock = Object.keys(env).length === 0 ? '' : `
          env:
${
    Object.entries(env)
      .map(([key, value]) => `            - name: ${key}\n              value: '${value}'`)
      .join('\n')
  }`;

  return `# ${name}
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${name}
  # Pinned, never implicit: an object whose namespace is left to the caller applies
  # cleanly into whichever one happens to be current.
  namespace: \${NAMESPACE}
  labels:
    app.kubernetes.io/name: ${name}
    app.kubernetes.io/part-of: \${WORKSPACE}
spec:
  replicas: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: ${name}
  template:
    metadata:
      labels:
        app.kubernetes.io/name: ${name}
        app.kubernetes.io/part-of: \${WORKSPACE}
    spec:
      # Only real because the generated entry installs a SIGTERM handler; without
      # one the container dies from the signal in milliseconds.
      terminationGracePeriodSeconds: 30
      securityContext:
        runAsNonRoot: true
        # NUMERIC. runAsNonRoot refuses an image whose user is a name —
        # "cannot verify user is non-root" — and that fails only here, never in
        # Docker.
        runAsUser: ${RUN_AS_USER}
        runAsGroup: ${RUN_AS_USER}
        fsGroup: ${RUN_AS_USER}
      containers:
        - name: ${name}
          # Build with:
          #   docker build -f docker/Dockerfile --build-arg MEMBER=${name} -t ${name}:dev .
          # then push it to a registry this cluster can pull from and put that
          # reference here.
          image: ${name}:dev
          imagePullPolicy: IfNotPresent
          ports:
            - name: http
              containerPort: ${port}
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: ['ALL']${envBlock}
          # A TCP probe, not an HTTP one: \`/live\` and \`/ready\` exist only when this
          # member registers HealthPlugin, which depends on its template. Switch to
          # \`httpGet: { path: /ready, port: http }\` once it does — it is the better
          # signal, because it waits for the plugins rather than for the socket.
          readinessProbe:
            tcpSocket:
              port: http
            initialDelaySeconds: 2
            periodSeconds: 5
          livenessProbe:
            tcpSocket:
              port: http
            initialDelaySeconds: 10
            periodSeconds: 10
          resources:
            requests:
              cpu: 50m
              memory: 128Mi
            limits:
              memory: 512Mi
          volumeMounts:
            # Only /tmp. An emptyDir over the module-cache directory would MASK the
            # cache baked in at build time, and every pod would then re-resolve its
            # dependencies from the network at startup.
            - name: tmp
              mountPath: /tmp
      volumes:
        - name: tmp
          emptyDir: {}
---
apiVersion: v1
kind: Service
metadata:
  name: ${name}
  namespace: \${NAMESPACE}
  labels:
    app.kubernetes.io/name: ${name}
    app.kubernetes.io/part-of: \${WORKSPACE}
spec:
  # The name every sibling dials: the generated discovery map reads
  # \`${name.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase()}_HOST\`, and in a cluster
  # that value is this Service's name.
  selector:
    app.kubernetes.io/name: ${name}
  ports:
    - name: http
      port: ${port}
      targetPort: http
`;
}

/**
 * Builds the Kubernetes objects for a workspace.
 *
 * Regenerated for every member on each `generate app`, like the Compose stack and
 * for the same reason: the ports and the sibling names come from one manifest.
 *
 * @param manifest - The workspace as it will be after the current command
 * @param transport - The workspace's transport
 * @returns The files to write, relative to the workspace root
 */
export function workspaceK8sFiles(
  manifest: WorkspaceManifest,
  transport: TransportSpec,
): readonly GeneratedFile[] {
  if (manifest.members.length === 0) return [];

  const members = [...manifest.members].sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0
  );

  const documents = members.map((member) =>
    memberObjects(
      member.name,
      member.port,
      members.filter((other) => other.name !== member.name),
      transport,
    )
  );

  const readme = `# Kubernetes

Generated by \`setu generate app\` — one Deployment and one Service per member,
regenerated whenever a member is added.

\`\${NAMESPACE}\` and \`\${WORKSPACE}\` are placeholders, not shell variables: fill
them in, or pipe the file through \`envsubst\`:

\`\`\`bash
NAMESPACE=acme WORKSPACE=acme envsubst < ${K8S_DIR}/members.yaml | kubectl apply -f -
\`\`\`

What this does NOT include, deliberately:

- **An Ingress.** Which controller, which host, and which TLS issuer are cluster
  decisions, and a guessed Ingress is one that silently routes nothing.
- **The transport's backing service.** ${
    transport.compose === undefined
      ? 'This workspace needs none.'
      : `A ${transport.name} for a cluster is a managed service or a StatefulSet with storage, ` +
        `not the single container the Compose stack runs for development.`
  }
- **HTTP probes.** The probes are \`tcpSocket\`, because \`/live\` and \`/ready\` exist
  only when a member registers HealthPlugin. Switch them once it does.
- **A discovery backend.** These objects make each member reachable by its Service
  name, which is what the generated map's \`<MEMBER>_HOST\` variables are set to
  here. For anything beyond a fixed list, use the plugin's \`kubernetes\` provider —
  it needs the RBAC documented in this repository's deployment guide.
`;

  return [
    {
      path: `${K8S_DIR}/members.yaml`,
      contents: documents.join('---\n'),
      managed: true,
    },
    { path: `${K8S_DIR}/README.md`, contents: readme, managed: true },
  ];
}
