import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { rewritePluginArgs, wrapPluginArgs } from '../../src/templates/plugin-args.ts';
import { type ResolvedHost, resolveHost } from '../../src/templates/project-files.ts';
import { MINIMAL_HOST } from '../../src/templates/minimal.ts';

describe('wrapPluginArgs', () => {
  it('leaves a short literal untouched', () => {
    expect(wrapPluginArgs("{ broker: 'redis-streams' }")).toBe("{ broker: 'redis-streams' }");
  });

  it('wraps a long literal one member per line', () => {
    const wrapped = wrapPluginArgs(
      "{ broker: 'redis-streams', url: Deno.env.get('REDIS_URL') ?? 'redis://127.0.0.1:6379' }",
    );
    expect(wrapped).toBe(
      "{\n        broker: 'redis-streams',\n" +
        "        url: Deno.env.get('REDIS_URL') ?? 'redis://127.0.0.1:6379',\n      }",
    );
  });

  it('keeps a nested object on its line', () => {
    const literal = "{ binding: 'MESSAGES', rpc: { binding: 'REPLY_INBOX' }, extraPadding: 'x' }";
    expect(wrapPluginArgs(literal)).toBe(
      "{\n        binding: 'MESSAGES',\n        rpc: { binding: 'REPLY_INBOX' },\n        extraPadding: 'x',\n      }",
    );
  });

  it('never splits on a comma inside a quoted string', () => {
    // The literal is over budget and gets wrapped, but its one member — whose
    // value contains many commas — stays on ONE line.
    const literal = "{ url: 'a,b,c,d,e,f,g,h,i,j,k,l,m,n,o,p,q,r,s,t,u,v,w,x,y,z,more,still' }";
    expect(wrapPluginArgs(literal)).toBe(
      `{\n        url: 'a,b,c,d,e,f,g,h,i,j,k,l,m,n,o,p,q,r,s,t,u,v,w,x,y,z,more,still',\n      }`,
    );
  });

  it('returns a non-object literal unchanged even when long', () => {
    const literal = "'aaaaaaaaaa','bbbbbbbbbb','cccccccccc','dddddddddd','eeeeeeeeee','ffffffffff'";
    expect(wrapPluginArgs(literal)).toBe(literal);
  });
});

describe('rewritePluginArgs', () => {
  function hostWith(pkg: string): ResolvedHost {
    return resolveHost({ ...MINIMAL_HOST, plugins: [{ pkg, symbol: 'X' }] }, 'deno');
  }

  it('rewrites only the named package wiring', () => {
    const host = resolveHost({
      ...MINIMAL_HOST,
      plugins: [
        { pkg: 'messaging-plugin', symbol: 'MessagingPlugin' },
        { pkg: 'queue-plugin', symbol: 'QueuePlugin' },
      ],
    }, 'deno');
    const next = rewritePluginArgs(
      host,
      'queue-plugin',
      (c) => `{ adapter: 'redis', url: ${c} }`,
      'CONN',
    );
    expect(next.plugins.find((w) => w.pkg === 'queue-plugin')?.args).toBe(
      wrapPluginArgs("{ adapter: 'redis', url: CONN }"),
    );
    // The other wiring is untouched.
    expect(next.plugins.find((w) => w.pkg === 'messaging-plugin')).toEqual(
      host.plugins.find((w) => w.pkg === 'messaging-plugin'),
    );
  });

  it('returns the input identity-equal when no wiring matches', () => {
    const host = hostWith('config-plugin');
    expect(rewritePluginArgs(host, 'messaging-plugin', () => '{ x: 1 }', 'CONN')).toBe(host);
  });
});
