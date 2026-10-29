/** The Node devtool's conservative package.json merge, shared by all CLI entry points. */
import { withDependency } from '../commands/add.ts';
import { FRAMEWORK_RANGE } from '../templates/framework-specifier.ts';
import { escapeName } from '../utils/names.ts';

/** The non-watching development script reserved for the Node connector. */
export const NODE_DEVTOOL_DEV_SCRIPT = 'tsx main.dev.ts';

/** A refused manifest or its optional replacement; absent contents means no write. */
export type NodeDevtoolPlan =
  | { readonly ok: true; readonly contents?: string }
  | { readonly ok: false; readonly message: string };

/** A parsed JSON object, excluding arrays and null. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Plans the development script and development-only diagnostics dependency.
 * Never upgrades a framework pin or replaces a developer's script.
 *
 * @param source - The member's own package.json, optionally prefixed by a BOM
 * @param path - Its display path, used in terminal-safe refusals
 * @returns A refusal, replacement contents, or a successful no-op
 */
export function planNodeDevtool(source: string, path = 'package.json'): NodeDevtoolPlan {
  const clean = source.replace(/^\uFEFF/, '');
  let parsed: unknown;
  try {
    parsed = JSON.parse(clean);
  } catch {
    return { ok: false, message: `Invalid JSON in ${escapeName(path)}; nothing was written.` };
  }
  if (!isRecord(parsed)) {
    return { ok: false, message: `${escapeName(path)} must contain a JSON object.` };
  }
  for (const section of ['dependencies', 'devDependencies', 'scripts']) {
    const value = parsed[section];
    if (
      value !== undefined &&
      (!isRecord(value) || Object.values(value).some((entry) => typeof entry !== 'string'))
    ) {
      return {
        ok: false,
        message: `${escapeName(path)}: ${section} must be an object of strings.`,
      };
    }
  }
  const dependencies = (parsed['dependencies'] ?? {}) as Record<string, string>;
  const devDependencies = (parsed['devDependencies'] ?? {}) as Record<string, string>;
  const scripts = (parsed['scripts'] ?? {}) as Record<string, string>;
  const mismatches = [dependencies, devDependencies].flatMap((entries) =>
    Object.entries(entries)
      .filter(([name, range]) => name.startsWith('@setu-ts/') && range !== FRAMEWORK_RANGE)
      .map(
        ([name, range]) =>
          `${escapeName(name)}: ${escapeName(range)} (expected ${FRAMEWORK_RANGE})`,
      ),
  );
  if (mismatches.length > 0) {
    return {
      ok: false,
      message: `Framework pins in ${escapeName(path)} disagree:\n${mismatches.join('\n')}\nUpgrade the project first (see docs/upgrading.md), then run this again.`,
    };
  }
  if (Object.hasOwn(dependencies, '@setu-ts/diagnostics-plugin')) {
    return {
      ok: false,
      message: `${escapeName(path)} lists @setu-ts/diagnostics-plugin in dependencies. Move it to devDependencies so the production image omits it.`,
    };
  }
  if (!Object.hasOwn(devDependencies, 'tsx')) {
    return {
      ok: false,
      message: `${escapeName(path)} requires tsx in devDependencies to run the development entry.`,
    };
  }
  if (scripts['dev'] !== undefined && scripts['dev'] !== NODE_DEVTOOL_DEV_SCRIPT) {
    return {
      ok: false,
      message: `Refusing to replace the existing "dev" script in ${escapeName(path)}:\n  current: ${escapeName(scripts['dev'])}\n  would write: ${NODE_DEVTOOL_DEV_SCRIPT}\nA script you wrote is yours to change; update it to match, or remove it, and run this again.`,
    };
  }
  const updated = withDependency(
    clean,
    'devDependencies',
    '@setu-ts/diagnostics-plugin',
    FRAMEWORK_RANGE,
  );
  if (scripts['dev'] === NODE_DEVTOOL_DEV_SCRIPT) {
    return updated === undefined ? { ok: true } : { ok: true, contents: updated };
  }
  const manifest = JSON.parse(updated ?? clean) as Record<string, unknown>;
  return {
    ok: true,
    contents: `${JSON.stringify({ ...manifest, scripts: { ...scripts, dev: NODE_DEVTOOL_DEV_SCRIPT } }, null, 2)}\n`,
  };
}
