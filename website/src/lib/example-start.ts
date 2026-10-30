/**
 * The "Try it" box at the top of every example page.
 *
 * Every example README opens with `pnpm --dir apps/<name> …`, which only works inside
 * a clone of the repository. The box gives a reader without one the command that does
 * work, read from the CLI's own example catalog so the site cannot offer an example
 * the CLI refuses, or miss one it adds.
 */

import { EXAMPLES, EXCLUDED_EXAMPLES } from '../../../packages/cli/src/examples/catalog.ts';

export type ExampleStart =
  /** `npm create … --example <name>` reproduces this example outside the repository. */
  | { kind: 'example'; command: string }
  /** Repository-only; `command` starts the nearest project the CLI recommends instead. */
  | { kind: 'repository'; command: string };

const CREATE = 'npm create @setu-ts my-app --';

export function exampleStart(app: string): ExampleStart {
  if ((EXAMPLES as readonly string[]).includes(app)) {
    return { kind: 'example', command: `${CREATE} --example ${app}` };
  }
  const reason = EXCLUDED_EXAMPLES[app];
  if (reason === undefined) {
    throw new Error(`example-start: ${app} is neither offered nor excluded by the CLI catalog`);
  }
  // The catalog phrases each exclusion as "…; use --<flag> <value>…".
  const alternative = /\buse (--[a-z-]+ [a-z-]+)/.exec(reason)?.[1];
  if (alternative === undefined) {
    throw new Error(`example-start: no "use --flag value" alternative in the reason for ${app}`);
  }
  return { kind: 'repository', command: `${CREATE} ${alternative}` };
}

/**
 * Renders the box. It deliberately contains no `<p>`: the page's meta description is
 * the first paragraph of the README, and the box sits before it.
 */
export function tryItHtml(app: string): string {
  const start = exampleStart(app);
  const lead =
    start.kind === 'example'
      ? 'Start your own copy of this example:'
      : 'This example runs inside the Setu-TS repository. To start a similar project:';
  // The run step is what `setu new` itself prints next: an `--example` project serves
  // with `npm start`, a Workers scaffold with Wrangler, every other scaffold with
  // `start:dev` (packages/cli/src/commands/new.ts).
  const run =
    start.kind === 'example'
      ? 'npm start'
      : start.command.includes('cloudflare-workers')
        ? 'npx wrangler dev'
        : 'npm run start:dev';
  // Written as entities: the box is raw HTML, so `&` must not reach it bare.
  const commands = `${start.command}\ncd my-app &amp;&amp; npm install\n${run}`;
  return (
    '<div class="try-it">' +
    '<div class="try-it-title">Try it</div>' +
    `<div>${lead}</div>` +
    `<pre><code>${commands}</code></pre>` +
    '<div class="try-it-note">The commands further down run inside a clone of the repository.</div>' +
    '</div>'
  );
}

/** Inserts `fragment` straight after the page's first `</h1>`, or first when there is none. */
export function insertAfterTitle(html: string, fragment: string): string {
  const end = html.search(/<\/h1>/i);
  if (end === -1) return fragment + html;
  const at = end + '</h1>'.length;
  return html.slice(0, at) + fragment + html.slice(at);
}
