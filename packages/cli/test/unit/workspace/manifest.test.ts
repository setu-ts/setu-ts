import { describe, expect, it } from 'vitest';
import { createFakeFs } from '../../fixtures/fake-fs.ts';
import {
  allocatePort,
  isUsablePort,
  manifestProblemDetail,
  MAX_PORT,
  MIN_PORT,
  readWorkspaceManifest,
  renderWorkspaceManifest,
  WORKSPACE_MANIFEST,
  WORKSPACE_VERSION,
  type WorkspaceManifest,
} from '../../../src/workspace/manifest.ts';
import { escapeName } from '../../../src/utils/names.ts';

/**
 * Seeds a workspace root holding the given manifest text.
 *
 * @param contents - The manifest file's contents
 * @returns A fake filesystem rooted at `/ws`
 */
function workspace(contents: string) {
  return createFakeFs({ [`/ws/${WORKSPACE_MANIFEST}`]: contents });
}

describe('readWorkspaceManifest', () => {
  it('reads a well-formed manifest', async () => {
    const fs = workspace(
      renderWorkspaceManifest({
        version: WORKSPACE_VERSION,
        runtime: 'deno',
        basePort: 3000,
        broker: 'memory',
        members: [{ name: 'orders', port: 3000 }],
      }),
    );
    const result = await readWorkspaceManifest(fs, '/ws');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.basePort).toBe(3000);
    expect(result.manifest.members).toEqual([{ name: 'orders', port: 3000 }]);
  });

  it('reads dependency metadata only when every named sibling exists', async () => {
    const fs = workspace(
      renderWorkspaceManifest({
        version: WORKSPACE_VERSION,
        runtime: 'deno',
        basePort: 3000,
        broker: 'memory',
        members: [
          { name: 'orders', port: 3000 },
          { name: 'billing', port: 3001, dependsOn: ['orders'] },
        ],
      }),
    );
    const result = await readWorkspaceManifest(fs, '/ws');
    expect(result.ok).toBe(true);

    const invalid = workspace(
      JSON.stringify({
        version: WORKSPACE_VERSION,
        runtime: 'deno',
        basePort: 3000,
        broker: 'memory',
        members: [{ name: 'billing', port: 3001, dependsOn: ['orders'] }],
      }),
    );
    const refused = await readWorkspaceManifest(invalid, '/ws');
    expect(refused.ok).toBe(false);
  });

  // "Not a workspace" and "this workspace is broken" need different advice, so
  // the two are reported distinctly rather than as one failure.
  it('reports an absent manifest as absent, not malformed', async () => {
    const result = await readWorkspaceManifest(createFakeFs(), '/ws');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem.kind).toBe('absent');
  });

  it('reports malformed JSON', async () => {
    const result = await readWorkspaceManifest(workspace('{ not json'), '/ws');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem.kind).toBe('malformed');
  });

  it('reports a JSON value that is not an object', async () => {
    const result = await readWorkspaceManifest(workspace('[]'), '/ws');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem.kind).toBe('malformed');
  });

  it('reports a null document', async () => {
    const result = await readWorkspaceManifest(workspace('null'), '/ws');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem.kind).toBe('malformed');
  });

  it('reports a missing version', async () => {
    const result = await readWorkspaceManifest(workspace('{"basePort":3000,"members":[]}'), '/ws');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem.kind).toBe('malformed');
  });

  // A version this CLI does not know must never be read with a guessed shape.
  it('reports an unsupported version, carrying the number', async () => {
    const result = await readWorkspaceManifest(
      workspace('{"version":99,"basePort":3000,"members":[]}'),
      '/ws',
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem.kind).toBe('unsupported-version');
    if (result.problem.kind !== 'unsupported-version') return;
    expect(result.problem.version).toBe(99);
  });

  // A fractional basePort is reported as the unusable PORT it is rather than as
  // an unreadable manifest: "this is not a readable workspace manifest" would
  // send a developer hunting for a syntax error in a file whose only problem is
  // one number.
  it('reports a non-integer basePort as an invalid port', async () => {
    const result = await readWorkspaceManifest(
      workspace(`{"version":${WORKSPACE_VERSION},"basePort":30.5,"members":[]}`),
      '/ws',
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem.kind).toBe('invalid-port');
  });

  /**
   * Reads a manifest from its JSON text.
   *
   * @param text - The manifest file's contents
   * @returns The reader's result
   */
  function read(text: string) {
    return readWorkspaceManifest(workspace(text), '/ws');
  }

  it('reports a brokerUrl that is not a string', async () => {
    const result = await read(
      `{"version":${WORKSPACE_VERSION},"basePort":3000,"broker":"redis","brokerUrl":42,"members":[]}`,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem.kind).toBe('malformed');
  });

  // Absent → memory: the messaging plugin's own default, stated as a choice.
  it('defaults an absent broker to memory rather than refusing', async () => {
    const result = await read(`{"version":${WORKSPACE_VERSION},"basePort":3000,"members":[]}`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.broker).toBe('memory');
    expect(result.manifest.brokerUrl).toBeUndefined();
  });

  it('reads a broker and its endpoint back', async () => {
    const result = await read(
      `{"version":${WORKSPACE_VERSION},"basePort":3000,"broker":"redis",` +
        `"brokerUrl":"redis://shared:6379","members":[]}`,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.broker).toBe('redis');
    expect(result.manifest.brokerUrl).toBe('redis://shared:6379');
  });

  // Refused rather than defaulted: quietly moving every member off the bus the
  // manifest asked for would leave services that cannot reach each other.
  for (const [label, value] of [
    ['an unknown name', '"carrier-pigeon"'],
    ['a call style', '"grpc"'],
    ['a number', '42'],
  ]) {
    it(`refuses ${label} as the broker`, async () => {
      const result = await read(
        `{"version":${WORKSPACE_VERSION},"basePort":3000,"broker":${value},"members":[]}`,
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.problem).toEqual({
        kind: 'unknown-broker',
        broker: String(JSON.parse(value)),
      });
    });
  }

  // Only an absent field takes the default; an explicit null is refused by name.
  for (const version of [1, 2]) {
    const field = version === 1 ? 'transport' : 'broker';
    it(`refuses an explicit null ${field} in a version-${version} manifest`, async () => {
      const result = await read(
        `{"version":${version},"basePort":3000,"${field}":null,"members":[]}`,
      );
      expect(result).toEqual({ ok: false, problem: { kind: 'unknown-broker', broker: 'null' } });
    });
  }

  // A stored URL only where `--broker-url` would accept one: the cloud brokers'
  // values are a project id and a secret, and memory has no endpoint.
  for (const broker of ['memory', 'pubsub', 'service-bus']) {
    for (const version of [1, 2]) {
      it(`refuses a stored URL for ${broker} in a version-${version} manifest`, async () => {
        const fields =
          version === 1
            ? `"transport":"${broker}","transportUrl":"redis://x:1"`
            : `"broker":"${broker}","brokerUrl":"redis://x:1"`;
        const result = await read(`{"version":${version},"basePort":3000,${fields},"members":[]}`);
        expect(result).toEqual({ ok: false, problem: { kind: 'malformed' } });
      });
    }
  }

  // A version-2 file still carrying a version-1 field is half-migrated: which
  // field wins is a guess, so neither does.
  for (const field of ['"transport":"redis"', '"transportUrl":"redis://x"']) {
    it(`refuses a version-2 manifest that still carries ${field}`, async () => {
      const result = await read(
        `{"version":${WORKSPACE_VERSION},"basePort":3000,"broker":"redis",${field},"members":[]}`,
      );
      expect(result).toEqual({ ok: false, problem: { kind: 'malformed' } });
    });
  }

  describe('a member name', () => {
    for (const name of ['Orders_V2', 'a--b', '123', 'billing\u000ax']) {
      it(`refuses ${JSON.stringify(name)} by name, and the detail suggests a rename where one exists`, async () => {
        const result = await read(
          JSON.stringify({
            version: WORKSPACE_VERSION,
            basePort: 3000,
            members: [{ name, port: 3000 }],
          }),
        );
        expect(result).toEqual({ ok: false, problem: { kind: 'invalid-member-name', name } });
        if (result.ok) return;
        const detail = manifestProblemDetail(result.problem) ?? '';
        expect(detail).toContain(`Its member "${escapeName(name)}" is not a name`);
        expect(detail).not.toContain('\n');
        expect(detail.includes('for example to')).toBe(name !== '123');
      });
    }

    it('gives no detail for a problem the generic refusal explains', () => {
      expect(manifestProblemDetail({ kind: 'malformed' })).toBeUndefined();
    });
  });

  describe('a member rpc', () => {
    it('reads grpc, and normalizes a spelled-out http to absent', async () => {
      const result = await read(
        `{"version":${WORKSPACE_VERSION},"basePort":3000,"members":[` +
          `{"name":"a","port":3000,"rpc":"grpc"},{"name":"b","port":3001,"rpc":"http"},` +
          `{"name":"c","port":3002}]}`,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.manifest.members).toEqual([
        { name: 'a', port: 3000, rpc: 'grpc' },
        { name: 'b', port: 3001 },
        { name: 'c', port: 3002 },
      ]);
    });

    for (const value of ['"rest"', '1', 'null']) {
      it(`refuses rpc ${value} as malformed`, async () => {
        const result = await read(
          `{"version":${WORKSPACE_VERSION},"basePort":3000,"members":[{"name":"a","port":3000,"rpc":${value}}]}`,
        );
        expect(result).toEqual({ ok: false, problem: { kind: 'malformed' } });
      });
    }
  });

  // M138 §3.1: the version-1 `transport` maps onto a broker and per-member rpc.
  // Every row here is a row of the plan's table; the result always carries the
  // CURRENT version, so a re-serialized manifest never writes `version: 1` back.
  describe('a version-1 manifest', () => {
    const MEMBERS = '[{"name":"a","port":3000},{"name":"b","port":3001}]';
    for (const [label, fields, broker, url, grpc] of [
      ['a broker transport', '"transport":"rabbitmq",', 'rabbitmq', undefined, false],
      [
        'a broker transport and its URL',
        '"transport":"redis","transportUrl":"redis://shared:6379",',
        'redis',
        'redis://shared:6379',
        false,
      ],
      ['the grpc transport', '"transport":"grpc",', 'memory', undefined, true],
      ['the http transport', '"transport":"http",', 'memory', undefined, false],
      ['no transport', '', 'memory', undefined, false],
    ] as const) {
      it(`maps ${label}`, async () => {
        const result = await read(`{"version":1,"basePort":3000,${fields}"members":${MEMBERS}}`);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.manifest.version).toBe(WORKSPACE_VERSION);
        expect(result.manifest.broker).toBe(broker);
        expect(result.manifest.brokerUrl).toBe(url);
        expect(result.manifest.members.map((member) => member.rpc)).toEqual(
          grpc ? ['grpc', 'grpc'] : [undefined, undefined],
        );
      });
    }

    for (const transport of ['http', 'grpc']) {
      it(`refuses a transportUrl beside the ${transport} transport`, async () => {
        const result = await read(
          `{"version":1,"basePort":3000,"transport":"${transport}","transportUrl":"redis://x","members":[]}`,
        );
        expect(result).toEqual({ ok: false, problem: { kind: 'malformed' } });
      });
    }

    for (const [label, value] of [
      ['an unknown name', '"carrier-pigeon"'],
      ['a number', '42'],
    ] as const) {
      it(`refuses ${label} as the transport, as an unknown broker`, async () => {
        const result = await read(
          `{"version":1,"basePort":3000,"transport":${value},"members":[]}`,
        );
        expect(result).toEqual({
          ok: false,
          problem: { kind: 'unknown-broker', broker: String(JSON.parse(value)) },
        });
      });
    }

    for (const field of ['"broker":"redis"', '"brokerUrl":"redis://x"', '"transportUrl":42']) {
      it(`refuses a version-1 manifest carrying ${field}`, async () => {
        const result = await read(`{"version":1,"basePort":3000,${field},"members":[]}`);
        expect(result).toEqual({ ok: false, problem: { kind: 'malformed' } });
      });
    }

    it('writes back as version 2 with the mapped fields', async () => {
      const result = await read(
        `{"version":1,"basePort":3000,"transport":"grpc","members":[{"name":"a","port":3000}]}`,
      );
      if (!result.ok) throw new Error('expected a manifest');
      const again = await read(renderWorkspaceManifest(result.manifest));
      expect(again).toEqual(result);
      expect(JSON.parse(renderWorkspaceManifest(result.manifest))).toMatchObject({
        version: 2,
        broker: 'memory',
        members: [{ name: 'a', port: 3000, rpc: 'grpc' }],
      });
    });
  });

  it('refuses version 3', async () => {
    const result = await read('{"version":3,"basePort":3000,"members":[]}');
    expect(result).toEqual({ ok: false, problem: { kind: 'unsupported-version', version: 3 } });
  });

  it('reports a missing basePort', async () => {
    const result = await readWorkspaceManifest(
      workspace(`{"version":${WORKSPACE_VERSION},"members":[]}`),
      '/ws',
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem.kind).toBe('malformed');
  });

  it('reports members that are not an array', async () => {
    const result = await readWorkspaceManifest(
      workspace(`{"version":${WORKSPACE_VERSION},"basePort":3000,"members":{}}`),
      '/ws',
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem.kind).toBe('malformed');
  });

  // One bad entry invalidates the manifest rather than being dropped: a
  // silently omitted member is one every sibling's map stops naming, and the
  // CLI would then hand its port to someone else.
  for (const [label, entry] of [
    ['a non-object entry', '"orders"'],
    ['a null entry', 'null'],
    ['an entry with no name', '{"port":3000}'],
    ['an entry with an empty name', '{"name":"","port":3000}'],
    ['an entry with no port', '{"name":"orders"}'],
    ['an entry whose port is not a number', '{"name":"orders","port":"3000"}'],
  ] as const) {
    it(`reports ${label}`, async () => {
      const result = await readWorkspaceManifest(
        workspace(`{"version":${WORKSPACE_VERSION},"basePort":3000,"members":[${entry}]}`),
        '/ws',
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.problem.kind).toBe('malformed');
    });
  }

  // A port outside the bindable range is checked on the way IN, because every
  // one of them is written into a member's own entry point AND into every
  // sibling's discovery map. Verified against the real kernel: `app.start()`
  // throws `Invalid port (out of range)` for 99999 and -1, while 0 BINDS on an
  // arbitrary free port — so the member starts, looks healthy, and every sibling
  // dialling 0 is refused. All three must be refused here, not propagated.
  for (const port of [99999, 0, -1, 65536, 30.5]) {
    it(`refuses a member port of ${port}, naming the value and the member`, async () => {
      const result = await readWorkspaceManifest(
        workspace(
          `{"version":${WORKSPACE_VERSION},"basePort":3000,` +
            `"members":[{"name":"orders","port":${port}}]}`,
        ),
        '/ws',
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.problem.kind).toBe('invalid-port');
      if (result.problem.kind !== 'invalid-port') return;
      expect(result.problem.port).toBe(port);
      expect(result.problem.field).toContain('orders');
    });
  }

  it('refuses an out-of-range basePort, naming the field', async () => {
    const result = await readWorkspaceManifest(
      workspace(`{"version":${WORKSPACE_VERSION},"basePort":99999,"members":[]}`),
      '/ws',
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem.kind).toBe('invalid-port');
    if (result.problem.kind !== 'invalid-port') return;
    expect(result.problem.field).toBe('basePort');
  });

  it('reports a basePort that is not a number as malformed, not as a bad port', async () => {
    const result = await readWorkspaceManifest(
      workspace(`{"version":${WORKSPACE_VERSION},"basePort":"3000","members":[]}`),
      '/ws',
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem.kind).toBe('malformed');
  });

  it('accepts the range boundaries', async () => {
    const result = await readWorkspaceManifest(
      workspace(
        `{"version":${WORKSPACE_VERSION},"basePort":1,` +
          `"members":[{"name":"a","port":1},{"name":"b","port":65535}]}`,
      ),
      '/ws',
    );
    expect(result.ok).toBe(true);
  });
});

describe('isUsablePort', () => {
  it('accepts the whole bindable range and nothing outside it', () => {
    for (const usable of [MIN_PORT, 3000, MAX_PORT]) {
      expect(isUsablePort(usable)).toBe(true);
    }
    // 0 binds an arbitrary free port rather than failing, which is why it is
    // excluded here rather than left to `app.start()` to reject.
    for (const unusable of [0, -1, MAX_PORT + 1, 30.5, Number.NaN, '3000', null, undefined]) {
      expect(isUsablePort(unusable)).toBe(false);
    }
  });
});

describe('renderWorkspaceManifest', () => {
  it('round-trips through the reader', async () => {
    const manifest: WorkspaceManifest = {
      version: WORKSPACE_VERSION,
      runtime: 'deno',
      basePort: 4100,
      broker: 'memory',
      members: [
        { name: 'orders', port: 4100 },
        { name: 'billing', port: 4101 },
      ],
    };
    const result = await readWorkspaceManifest(workspace(renderWorkspaceManifest(manifest)), '/ws');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest).toEqual(manifest);
  });

  it('ends in a newline, so the file is not truncated on the last line', () => {
    const rendered = renderWorkspaceManifest({
      version: WORKSPACE_VERSION,
      runtime: 'deno',
      basePort: 3000,
      broker: 'memory',
      members: [],
    });
    expect(rendered.endsWith('\n')).toBe(true);
  });
});

describe('allocatePort', () => {
  it('gives the first member the base port', () => {
    expect(
      allocatePort({
        version: WORKSPACE_VERSION,
        runtime: 'deno',
        basePort: 3000,
        broker: 'memory',
        members: [],
      }),
    ).toBe(3000);
  });

  it('gives the next member one above the highest in use', () => {
    expect(
      allocatePort({
        version: WORKSPACE_VERSION,
        runtime: 'deno',
        basePort: 3000,
        broker: 'memory',
        members: [
          { name: 'a', port: 3000 },
          { name: 'b', port: 3001 },
        ],
      }),
    ).toBe(3002);
  });

  // Derived from the MAXIMUM, not the count: a member hand-edited to a higher
  // port must not have that port handed to someone else.
  it('respects a member hand-edited above the base', () => {
    expect(
      allocatePort({
        version: WORKSPACE_VERSION,
        runtime: 'deno',
        basePort: 3000,
        broker: 'memory',
        members: [
          { name: 'a', port: 4100 },
          { name: 'b', port: 3001 },
        ],
      }),
    ).toBe(4101);
  });

  // Member order comes from a file a human may reorder.
  it('does not depend on member order', () => {
    const ports = [
      { name: 'a', port: 3005 },
      { name: 'b', port: 3001 },
    ];
    const forwards = allocatePort({
      version: WORKSPACE_VERSION,
      runtime: 'deno',
      basePort: 3000,
      broker: 'memory',
      members: ports,
    });
    const backwards = allocatePort({
      version: WORKSPACE_VERSION,
      runtime: 'deno',
      basePort: 3000,
      broker: 'memory',
      members: [...ports].reverse(),
    });
    expect(forwards).toBe(backwards);
    expect(forwards).toBe(3006);
  });

  // 65536 is not a port. Handing it out would write a `main.ts` that throws
  // `Invalid port (out of range)` the first time it runs.
  it('reports exhaustion rather than allocating past the range', () => {
    expect(
      allocatePort({
        version: WORKSPACE_VERSION,
        runtime: 'deno',
        basePort: MAX_PORT,
        broker: 'memory',
        members: [{ name: 'a', port: MAX_PORT }],
      }),
    ).toBeUndefined();
  });

  it('still allocates the last usable port', () => {
    expect(
      allocatePort({
        version: WORKSPACE_VERSION,
        runtime: 'deno',
        basePort: MAX_PORT - 1,
        broker: 'memory',
        members: [{ name: 'a', port: MAX_PORT - 1 }],
      }),
    ).toBe(MAX_PORT);
  });
});
