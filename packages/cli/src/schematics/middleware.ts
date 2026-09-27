/**
 * Middleware schematic — a middleware factory and its pipeline position.
 *
 * @module
 */

import type { DerivedNames, GeneratedFile, SchematicOptions } from './registry.ts';
import {
  GENERATED_MIDDLEWARE_EXPORT,
  MIDDLEWARE_SEAM,
  middlewarePriorityExport,
} from '../seams/middleware.ts';
import { seamNames } from '../seams/seam-spec.ts';

/**
 * The pipeline position a generated middleware starts at.
 *
 * `500` is the kernel's own default, so the emitted value reorders nothing: a
 * generated middleware lands exactly where a bare `app.middleware.add(fn())` would
 * have put it. It is emitted EXPLICITLY rather than left to that default because the
 * seam barrel has to pass a number, and a silent default is how a scaffolded project
 * once ended up with an error handler that could not catch a metrics throw.
 */
const DEFAULT_PRIORITY = 500;

/** One band of the pipeline that framework plugins occupy. */
export interface FrameworkMiddlewareBand {
  /** Lowest priority in the band. */
  readonly from: number;
  /** Highest priority in the band; equal to `from` for a single position. */
  readonly to: number;
  /** What sits there, as the generated comment names it. */
  readonly owner: string;
}

/**
 * Where the framework's own middleware sits, as the generated comment reports it.
 *
 * Data rather than prose, because the comment is a claim about OTHER packages: each
 * plugin keeps its priority in a private constant, so a prose list here drifts the
 * moment one moves (the first version of this comment omitted tenant resolution at 40
 * and request logging at 100). A test boots each owning plugin and asserts its
 * registered priorities fall inside the band this table names.
 */
export const FRAMEWORK_MIDDLEWARE_BANDS: readonly FrameworkMiddlewareBand[] = [
  { from: 0, to: 0, owner: 'error handler' },
  { from: 20, to: 20, owner: 'metrics' },
  { from: 30, to: 30, owner: 'telemetry' },
  { from: 40, to: 40, owner: 'tenant resolution' },
  { from: 100, to: 100, owner: 'request logging' },
  { from: 120, to: 275, owner: 'HTTP security, session and form CSRF' },
];

/**
 * Renders the bands as the comment's reference list.
 *
 * @returns E.g. `0 (error handler), 20 (metrics), …`
 */
function renderBands(): string {
  return FRAMEWORK_MIDDLEWARE_BANDS.map((band) =>
    `${band.from === band.to ? band.from : `${band.from}–${band.to}`} (${band.owner})`
  ).join(', ');
}

/**
 * Wraps prose into ` * `-prefixed JSDoc lines of at most 80 characters of text.
 *
 * Well inside the generated `lineWidth`, and fixed rather than derived from it:
 * `deno fmt` does not reflow comments, so any width it accepts is stable.
 *
 * @param text - One paragraph
 * @returns The comment lines, joined with newlines
 */
function commentLines(text: string): string {
  const width = 80;
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line !== '' && line.length + 1 + word.length > width) {
      lines.push(` * ${line}`);
      line = word;
    } else {
      line = line === '' ? word : `${line} ${word}`;
    }
  }
  // Every caller passes non-empty prose, so the last line always holds a word.
  lines.push(` * ${line}`);
  return lines.join('\n');
}

/**
 * The paragraph a React Router project gets, pointing at the OTHER middleware layer.
 *
 * A full-stack project has two, and they are not interchangeable: this one runs for
 * every request the kernel serves — API routes, health probes, static files and the
 * SSR catch-all alike — and sees the kernel request context; a route module's
 * `middleware` export runs only for the SSR routes it matches and sees React Router's
 * context, which is where a session-derived user lives. Emitted only when the project
 * installs `react-router-plugin`, so no other project's output changes.
 */
const REACT_ROUTER_NOTE = commentLines(
  'This is the KERNEL layer: it runs for every request, including health probes and ' +
    'API routes as well as SSR pages. For logic that belongs to a group of pages — ' +
    'redirecting to /login, putting the signed-in user on the loader context — export ' +
    'a `middleware` array from the route module instead. A project scaffolded with ' +
    '`--template full-stack` has a worked example in app/middleware/, and its README ' +
    'explains the split.',
);

/**
 * Generates a middleware factory and regenerates the seam barrel that adds it.
 *
 * @param names - Naming forms derived from the user's input
 * @param options - Supplies the middleware already present, for the barrel
 * @returns The middleware at `src/middleware/<kebab>.middleware.ts`, plus the managed
 *   `src/middleware/index.ts` barrel
 */
export function generateMiddleware(
  names: DerivedNames,
  options: SchematicOptions,
): readonly GeneratedFile[] {
  const priorityConst = middlewarePriorityExport(names.screaming);
  const contents = `import type { MiddlewareFunction } from '@setu-ts/common';

/**
 * Where this middleware sits in the pipeline. Lower runs earlier, so lower is
 * outermost; \`500\` is the framework default.
 *
 * Change it HERE, not in \`src/middleware/index.ts\` — the CLI regenerates that barrel
 * from this constant, so an edit there is lost on the next generate.
 *
${
    commentLines(
      `For reference, the framework's own middleware occupy ${renderBands()}. Keep a ` +
        'value above 0, so an installed error handler still formats what this middleware throws.',
    )
  }
 */
export const ${priorityConst} = ${DEFAULT_PRIORITY};

/**
 * Creates the ${names.kebab} middleware.
 *
 * Added for you through the \`${GENERATED_MIDDLEWARE_EXPORT}\` barrel in
 * \`src/middleware/index.ts\`, which \`setu.config.ts\` walks — so this module needs no
 * further wiring. Call \`${names.camel}Middleware()\` directly to add it to one route's
 * \`middleware\` list, or from a plugin's \`ctx.middleware.add(...)\`.
 *${options.plugins.has('react-router-plugin') ? `\n${REACT_ROUTER_NOTE}\n *` : ''}
 * @returns The middleware function
 */
export function ${names.camel}Middleware(): MiddlewareFunction {
  return async (ctx, next) => {
    // Runs before the handler. To short-circuit, write a response here and return
    // without calling next() — nothing after this stage, the handler included, runs.
    await next();
    // Runs after the handler.
    ctx.response.header('X-${names.pascal}', 'true');
  };
}
`;
  return [
    { path: `src/middleware/${names.kebab}.middleware.ts`, contents },
    {
      path: MIDDLEWARE_SEAM.barrel,
      contents: MIDDLEWARE_SEAM.renderBarrel({
        middleware: seamNames(options.artifacts, 'middleware', names.kebab),
      }),
      managed: true,
    },
  ];
}
