/**
 * `setu check` W006 on a starter-composed configuration: an installed package
 * whose gated starter arm is unset is reported; an always-on arm, `auth-plugin`,
 * an arm the check cannot read, and an inline registration are not.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { starterArmSet } from '../../src/commands/starter-options.ts';
import { renderCheckFindings } from '../../src/diagnostics/render.ts';
import { unregisteredPluginFindings } from '../../src/diagnostics/wiring.ts';
import { GATED_STARTER_ARMS, STARTER_ARMS } from '../../src/utils/starter-arms.ts';

const FULL_STACK_IMPORT =
  "import { createFullStackAppFromConfig, type FullStackStarterOptions } from '@setu-ts/full-stack-starter';";

/** The generated full-stack shape: a typed callback returning the options object. */
function fullStack(returned: string, after = ''): string {
  return `${FULL_STACK_IMPORT}
export async function createApp() {
  const app = await createFullStackAppFromConfig(
    (config): FullStackStarterOptions => {
      return {
        ${returned}
      };
    },
    { env },
  );
  ${after}
  return app;
}
`;
}

/** The packages a finding list names, in order. */
function reported(config: string, installed: readonly string[]): readonly string[] {
  return unregisteredPluginFindings(config, new Set(installed)).map((finding) =>
    finding.kind === 'plugin-unregistered' ? finding.pkg : finding.kind,
  );
}

describe('starter arms in setu check', () => {
  it('reports an installed package whose gated arm the generated callback leaves out', () => {
    const config = fullStack(
      "reactRouter: { build: './build' },\n        session: { secret: 's' },\n        logger: { requestLogging: true },",
    );
    const installed = [
      'react-router-plugin',
      'session-plugin',
      'graphql-plugin',
      'static-plugin',
      'auth-plugin',
      'logger-plugin',
      'cache-plugin',
    ];
    expect(unregisteredPluginFindings(config, new Set(installed))).toEqual([
      {
        kind: 'plugin-unregistered',
        pkg: 'graphql-plugin',
        symbol: 'GraphqlPlugin',
        starterArm: { arm: 'graphql', starter: 'createFullStackAppFromConfig' },
      },
      {
        kind: 'plugin-unregistered',
        pkg: 'static-plugin',
        symbol: 'StaticPlugin',
        starterArm: { arm: 'static', starter: 'createFullStackAppFromConfig' },
      },
    ]);
  });

  it('reads a realtime arm inside its parent literal', () => {
    const installed = ['websocket-plugin', 'sse-plugin', 'realtime-backplane-plugin'];
    expect(reported(fullStack('realtime: { sse: {} },'), installed)).toEqual([
      'websocket-plugin',
      'realtime-backplane-plugin',
    ]);
    expect(reported(fullStack('realtime: { websocket: false, sse: {} },'), installed)).toEqual([
      'websocket-plugin',
      'realtime-backplane-plugin',
    ]);
    // A parent that is not a literal cannot be read, so nothing is reported for it.
    expect(reported(fullStack('realtime,'), installed)).toEqual([]);
    expect(reported(fullStack('realtime: realtimeOptions,'), installed)).toEqual([]);
  });

  it('treats undefined, null and false as unset, and any other value as set', () => {
    for (const value of ['undefined', 'null', 'false']) {
      expect(reported(fullStack(`graphql: ${value},`), ['graphql-plugin'])).toEqual([
        'graphql-plugin',
      ]);
    }
    expect(reported(fullStack('graphql: graphqlOptions(config),'), ['graphql-plugin'])).toEqual([]);
    expect(reported(fullStack("'graphql': {},"), ['graphql-plugin'])).toEqual([]);
  });

  it('stays quiet on a shape it cannot read', () => {
    // Another `return` may hand back an object that does set the arm.
    const branched = fullStack('session: {},').replace(
      '      return {',
      "      if (config.get('GRAPHQL') === 'on') {\n        return { graphql: { schema } };\n      }\n      return {",
    );
    expect(branched).toContain("if (config.get('GRAPHQL')");
    expect(reported(branched, ['graphql-plugin'])).toEqual([]);
    expect(reported(fullStack('...base,'), ['graphql-plugin'])).toEqual([]);
    expect(reported(fullStack('graphql() { return {}; },'), ['graphql-plugin'])).toEqual([]);
    const twoCalls = `import { createRestApp } from '@setu-ts/rest-starter';\ncreateRestApp({});\ncreateRestApp({});`;
    expect(reported(twoCalls, ['database-plugin'])).toEqual([]);
    const passed = `import { createRestApp } from '@setu-ts/rest-starter';\ncreateRestApp(options);`;
    expect(reported(passed, ['database-plugin'])).toEqual([]);
    expect(
      reported(`${FULL_STACK_IMPORT}\nconst broken = 'unterminated`, ['graphql-plugin']),
    ).toEqual([]);
  });

  it('reads a hand-written starter call, and a call with no options sets nothing', () => {
    const rest = "import { createRestApp } from '@setu-ts/rest-starter';\n";
    expect(
      reported(`${rest}const app = createRestApp();`, ['database-plugin', 'di-plugin']),
    ).toEqual(['database-plugin', 'di-plugin']);
    expect(
      reported(`${rest}const app = createRestApp({ database: { type: 'memory' } });`, [
        'database-plugin',
        'di-plugin',
      ]),
    ).toEqual(['di-plugin']);
    // `react-router-plugin` is not a REST arm, so this starter leaves it to the inline check.
    expect(reported(`${rest}createRestApp();`, ['metrics-plugin'])).toEqual([]);
  });

  it('counts a registration beside the starter, aliased or not', () => {
    const register =
      "import { GraphqlPlugin as gql } from '@setu-ts/graphql-plugin';\n" +
      fullStack('', 'app.register(gql({ schema }));');
    expect(reported(register, ['graphql-plugin'])).toEqual([]);
    expect(
      reported(fullStack('', 'app.register(GraphqlPlugin({ schema }));'), ['graphql-plugin']),
    ).toEqual([]);
  });

  it('names the starter and the option to set', () => {
    const printed: string[] = [];
    renderCheckFindings(
      unregisteredPluginFindings(fullStack(''), new Set(['static-plugin'])),
      (line) => printed.push(line),
    );
    expect(printed).toEqual([
      'warning setu.W006: Installed @setu-ts/static-plugin is not composed: createFullStackAppFromConfig registers StaticPlugin only when its `static` option is set, and setu.config.ts does not set it.',
      "  Set `static` in the starter's options. If registered in another module, silence setu.W006 in .setu-ts/check.json.",
    ]);
  });

  it('answers each arm reader outcome directly', () => {
    expect(starterArmSet('const app = 1;', 'graphql')).toBeUndefined();
    expect(starterArmSet(fullStack('graphql: {},'), 'graphql')).toBe(true);
    expect(starterArmSet(fullStack('realtime: { sse: {} },'), 'realtime.sse')).toBe(true);
    expect(starterArmSet(fullStack('realtime: { sse: null },'), 'realtime.sse')).toBe(false);
    expect(starterArmSet(fullStack('realtime: undefined,'), 'realtime.sse')).toBe(false);
  });

  it('gates exactly the arms the starters register conditionally', () => {
    const sources = ['rest-starter', 'full-stack-starter']
      .map((pkg) =>
        readFileSync(new URL(`../../../starters/${pkg}/src/app.ts`, import.meta.url), 'utf8'),
      )
      .join('\n');
    const gated = new Map(
      [...sources.matchAll(/options\.(?:(realtime)\?\.)?(\w+) \? \[(\w+)\(/g)].map(
        ([, parent, arm, symbol]) => [symbol!, parent === undefined ? arm! : `${parent}.${arm}`],
      ),
    );
    const fullStackArms = STARTER_ARMS.find(({ pkg }) => pkg === 'full-stack-starter')!.arms;
    expect(
      new Map([...GATED_STARTER_ARMS].map(([pkg, symbol]) => [symbol, fullStackArms.get(pkg)])),
    ).toEqual(gated);
  });
});
