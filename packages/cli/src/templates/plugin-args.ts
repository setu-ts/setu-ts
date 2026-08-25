/**
 * Rewriting a rendered plugin call's argument list.
 *
 * Extracted from `workspace/member-host.ts`, which had the only two consumers:
 * the workspace transport overlay and — since M72 — the standalone
 * `setu new --broker/--queue` overlay. One implementation serves both, so the
 * top-level comma splitter and the wrap budget cannot drift between a member
 * and a standalone project on the first arm added.
 *
 * @module
 */
import type { ResolvedHost } from './project-files.ts';

/**
 * The column a rendered plugin call must stay inside.
 *
 * Six spaces of indent inside the generated `plugins: [` array, plus the
 * symbol and its parentheses — measured against the `fmt.lineWidth: 100` the
 * generated root manifest declares.
 */
const ARGS_BUDGET = 60;

/**
 * Wraps a rendered argument literal that would overflow the emitted line width.
 *
 * A broker connection read is long — `Deno.env.get('RABBITMQ_URL') ??
 * 'amqp://127.0.0.1:5672'` on its own is most of the budget — so the
 * single-line form pushed a fresh `--transport rabbitmq` scaffold past its own
 * formatter (X2-4). Emitting the wrapped form directly is what keeps a
 * generated project passing `deno fmt --check` with no edits, which is the bar
 * M63 set and this is the second place to miss it.
 *
 * Splits on TOP-LEVEL commas only: a nested `{ binding: 'X', rpc: {...} }` must
 * stay on its line, exactly as `deno fmt` leaves it.
 *
 * @param args - The rendered argument literal, without enclosing parentheses
 * @returns The literal, wrapped when it would overflow
 */
export function wrapPluginArgs(args: string): string {
  if (args.length <= ARGS_BUDGET) return args;
  if (!args.startsWith('{') || !args.endsWith('}')) return args;

  const body = args.slice(1, -1).trim();
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  let quote: string | undefined;

  for (const char of body) {
    if (quote !== undefined) {
      current += char;
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    if (char === '{' || char === '[' || char === '(') depth += 1;
    if (char === '}' || char === ']' || char === ')') depth -= 1;
    if (char === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim() !== '') parts.push(current.trim());

  return `{\n${parts.map((part) => `        ${part},`).join('\n')}\n      }`;
}

/**
 * Replaces the argument list of ONE package's wiring with a freshly rendered
 * one.
 *
 * Applied only when the host actually carries that wiring: a template that
 * registers no such plugin is returned IDENTITY-EQUAL, which is correct for a
 * workspace (some members legitimately register no messaging) and is refused
 * outright on the standalone path, where silence would be the silent success
 * §3.4 of the M72 plan exists to remove.
 *
 * @param host - The resolved host whose wirings are rewritten
 * @param pkg - The bare package name whose wiring is rewritten
 * @param render - Renders the new argument list from the connection expression
 * @param connection - The connection value, as a source expression
 * @returns The host with the wiring rewritten, or the input unchanged
 */
export function rewritePluginArgs(
  host: ResolvedHost,
  pkg: string,
  render: (connection: string) => string,
  connection: string,
): ResolvedHost {
  if (!host.plugins.some((wiring) => wiring.pkg === pkg)) return host;

  return {
    ...host,
    plugins: host.plugins.map((wiring) =>
      wiring.pkg === pkg ? { ...wiring, args: wrapPluginArgs(render(connection)) } : wiring
    ),
  };
}
