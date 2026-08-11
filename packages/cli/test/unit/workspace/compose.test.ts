import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  COMPOSE_FILE,
  DOCKERFILE,
  DOCKERIGNORE,
  workspaceContainerFiles,
} from '../../../src/workspace/compose.ts';
import {
  MEMBERS_DIR,
  WORKSPACE_VERSION,
  type WorkspaceManifest,
} from '../../../src/workspace/manifest.ts';
import { type TransportName, transportSpec } from '../../../src/workspace/transport.ts';

/**
 * Builds a manifest holding the given members.
 *
 * @param members - Name/port pairs
 * @param transport - The workspace's transport
 * @returns The manifest
 */
function manifestOf(
  members: readonly { name: string; port: number }[],
  transport: TransportName = 'http',
): WorkspaceManifest {
  return { version: WORKSPACE_VERSION, runtime: 'deno', basePort: 3000, transport, members };
}

/**
 * Reads one generated file's contents.
 *
 * @param files - The plan
 * @param path - The path to read
 * @returns Its contents
 */
function contentsOf(
  files: readonly { path: string; contents: string }[],
  path: string,
): string {
  const file = files.find((candidate) => candidate.path === path);
  expect(file).toBeDefined();
  return file?.contents ?? '';
}

describe('workspaceContainerFiles', () => {
  it('emits a Dockerfile, an ignore file and a Compose file, all managed', () => {
    const files = workspaceContainerFiles(
      manifestOf([{ name: 'orders', port: 3000 }]),
      transportSpec('http'),
    );
    expect(files.map((f) => f.path)).toEqual([DOCKERFILE, DOCKERIGNORE, COMPOSE_FILE]);
    // Managed, because both are regenerated on every `generate app`: without it
    // the second member would be refused as an overwrite.
    for (const file of files) expect(file.managed).toBe(true);
  });

  describe('the Dockerfile', () => {
    const dockerfile = () =>
      contentsOf(
        workspaceContainerFiles(
          manifestOf([{ name: 'orders', port: 3000 }]),
          transportSpec('http'),
        ),
        DOCKERFILE,
      );

    // One parameterized file rather than one per member (§11.1) — a workspace's
    // tenth service must not need a tenth near-identical Dockerfile.
    it('takes the member as a build argument', () => {
      expect(dockerfile()).toContain('ARG MEMBER');
      expect(dockerfile()).toContain(`COPY ${MEMBERS_DIR}/\${MEMBER}`);
    });

    // M39's finding: Kubernetes' runAsNonRoot refuses an image whose user is a
    // NAME — "cannot verify user is non-root" — while Docker resolves it happily,
    // so `USER deno` fails only once deployed.
    it('declares a numeric user', () => {
      expect(dockerfile()).toContain('USER 1000:1000');
      // The DIRECTIVE, not the substring: the file's own comment explains why a
      // named user is wrong, so a bare substring check fails on the explanation.
      expect(dockerfile()).not.toMatch(/^USER deno/m);
    });

    // A base older than the Deno that wrote the lockfile fails with
    // `Unsupported lockfile version`, and a floating tag makes that arrive on a
    // day nothing changed.
    it('pins the base image rather than floating', () => {
      expect(dockerfile()).toMatch(/FROM denoland\/deno:alpine-\d+\.\d+\.\d+/);
      expect(dockerfile()).not.toContain('deno:latest');
      expect(dockerfile()).not.toContain('deno:alpine\n');
    });

    // This is a security-focused framework; an image should not hand its process
    // every capability.
    it('runs with explicit permissions, never -A', () => {
      const contents = dockerfile();
      expect(contents).toContain('"--allow-net", "--allow-env", "--allow-read", "--allow-sys"');
      expect(contents).not.toContain('"-A"');
    });

    // Every member binds a different port, read from its own generated discovery
    // module, so one parameterized file has no single number to name.
    it('declares no EXPOSE, because the port is per member', () => {
      expect(dockerfile()).not.toContain('\nEXPOSE');
    });

    // Libraries and this file shipped together and did not compose: a member that
    // imports `@scope/shared` resolves it through `libs/`, and an image without
    // that directory fails at `deno cache` with the specifier unresolvable.
    // Reproduced by staging exactly this copy set outside Docker.
    //
    // The bracket glob is the load-bearing part, verified against a real build: a
    // plain `COPY libs` FAILS the build when the directory is absent, which every
    // workspace without a library would hit.
    it('copies every shared library, tolerating a workspace with none', () => {
      expect(dockerfile()).toContain('COPY lib[s] ./libs/');
    });
  });

  describe('the ignore file', () => {
    const ignore = () =>
      contentsOf(
        workspaceContainerFiles(
          manifestOf([{ name: 'orders', port: 3000 }]),
          transportSpec('http'),
        ),
        DOCKERIGNORE,
      );

    // Docker reads `<context>/.dockerignore`, and the context is the workspace
    // ROOT — one under docker/ beside the Dockerfile is read by nothing.
    it('sits at the workspace root, where Docker looks for it', () => {
      expect(DOCKERIGNORE).toBe('.dockerignore');
    });

    // The expensive one: `COPY apps/${MEMBER}` otherwise lays the HOST's
    // node_modules over the one the image just installed — host-built native
    // binaries inside a Linux image, and the separated install layer invalidated
    // by any local install.
    it('keeps every node_modules out, member and library locations included', () => {
      const contents = ignore();
      expect(contents).toContain('\nnode_modules\n');
      expect(contents).toContain(`${MEMBERS_DIR}/*/node_modules`);
      expect(contents).toContain('libs/*/node_modules');
    });

    it('keeps the repository history out of the build context', () => {
      expect(ignore()).toContain('\n.git\n');
    });
  });

  describe('the Compose file', () => {
    it('publishes each member on the port the manifest allocated it', () => {
      const compose = contentsOf(
        workspaceContainerFiles(
          manifestOf([{ name: 'orders', port: 3000 }, { name: 'billing', port: 3001 }]),
          transportSpec('http'),
        ),
        COMPOSE_FILE,
      );
      expect(compose).toContain("- '3000:3000'");
      expect(compose).toContain("- '3001:3001'");
      // The same number on both sides: the container binds what its generated
      // entry binds, which is what every sibling's map names.
      expect(compose).not.toContain(':8000');
    });

    // The defect this closes is invisible on a host and total in a stack: two
    // containers do not share a loopback interface, so a member reading
    // `127.0.0.1` from its own map dials ITSELF on its sibling's port. Verified
    // against a real stack — with the variable the request is a 200, without it
    // the fetch fails.
    it('gives every member its siblings host, by service name', () => {
      const compose = contentsOf(
        workspaceContainerFiles(
          manifestOf([
            { name: 'orders', port: 3000 },
            { name: 'billing', port: 3001 },
            { name: 'shipping', port: 3002 },
          ]),
          transportSpec('http'),
        ),
        COMPOSE_FILE,
      );
      // orders learns both peers and NOT itself.
      const ordersBlock = compose.slice(compose.indexOf('  orders:'));
      expect(ordersBlock).toContain("BILLING_HOST: 'billing'");
      expect(ordersBlock).toContain("SHIPPING_HOST: 'shipping'");
      expect(ordersBlock.slice(0, ordersBlock.indexOf('  shipping:'))).not.toContain('ORDERS_HOST');
    });

    // A manifest a human has reordered must not turn a no-op regeneration into a
    // diff — the same reason the discovery map sorts its entries.
    it('sorts services by name', () => {
      const compose = contentsOf(
        workspaceContainerFiles(
          manifestOf([{ name: 'orders', port: 3000 }, { name: 'billing', port: 3001 }]),
          transportSpec('http'),
        ),
        COMPOSE_FILE,
      );
      expect(compose.indexOf('  billing:')).toBeLessThan(compose.indexOf('  orders:'));
    });

    it('adds no backing service for a transport that needs none', () => {
      for (const name of ['http', 'grpc', 'memory'] as const) {
        const compose = contentsOf(
          workspaceContainerFiles(
            manifestOf([{ name: 'orders', port: 3000 }], name),
            transportSpec(name),
          ),
          COMPOSE_FILE,
        );
        expect(compose).not.toContain('image:');
        expect(compose).not.toContain('depends_on:');
      }
    });

    it('starts the broker and waits for it', () => {
      const compose = contentsOf(
        workspaceContainerFiles(
          manifestOf([{ name: 'orders', port: 3000 }], 'redis'),
          transportSpec('redis'),
        ),
        COMPOSE_FILE,
      );
      expect(compose).toContain('  redis:');
      expect(compose).toContain('image: redis:7');
      expect(compose).toContain('condition: service_healthy');
      // The endpoint the member reads is the SERVICE name, not the loopback
      // address baked into its config for host development.
      expect(compose).toContain("REDIS_URL: 'redis://redis:6379'");
    });

    // The generated entry installs a SIGTERM handler, so this window is real
    // rather than decorative — a member without one dies from the signal in
    // milliseconds.
    it('gives every member a shutdown grace period and a restart policy', () => {
      const compose = contentsOf(
        workspaceContainerFiles(
          manifestOf([{ name: 'orders', port: 3000 }], 'nats'),
          transportSpec('nats'),
        ),
        COMPOSE_FILE,
      );
      expect(compose).toContain('stop_grace_period: 30s');
      // The broker connection happens during plugin registration with no retry,
      // and the NATS image cannot be health-probed, so losing the race means the
      // member exits and Compose has to bring it back.
      expect(compose).toContain('restart: unless-stopped');
      expect(compose).toContain('condition: service_started');
    });

    it('ships the Service Bus emulator entity config beside the stack', () => {
      const files = workspaceContainerFiles(
        manifestOf([{ name: 'orders', port: 3000 }], 'service-bus'),
        transportSpec('service-bus'),
      );
      expect(files.map((f) => f.path)).toContain('docker/servicebus-config.json');
      // Managed like the rest: regenerated on every member, never refused.
      expect(files.every((f) => f.managed === true)).toBe(true);
      const compose = contentsOf(files, COMPOSE_FILE);
      // Two containers, not one: the emulator keeps its state in SQL.
      expect(compose).toContain('  servicebus:');
      expect(compose).toContain('  sqledge:');
      expect(compose).toContain('/ServiceBus_Emulator/ConfigFiles/Config.json:ro');
    });

    it('is empty of members before the first one is added', () => {
      const compose = contentsOf(
        workspaceContainerFiles(manifestOf([]), transportSpec('http')),
        COMPOSE_FILE,
      );
      expect(compose).toContain('services:');
      expect(compose).not.toContain('build:');
    });
  });
});
