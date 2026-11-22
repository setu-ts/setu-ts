/** The Node floor and supported range both executables check at startup. @module */

/**
 * The Node engine range declared by both CLI executables.
 * @since 0.14.0
 */
export const SUPPORTED_NODE = '^22.23.4 || ^24.22.1 || >=26.12.1';

/**
 * Lowest Node version on which the CLI and a freshly generated project both
 * work, measured on the official Node images: the CLI crashes on import on
 * Node 18; on 20 and 21 the generated `npm test` fails; 22.0.0 to 22.8.x
 * refuse the generated start script's `--env-file-if-exists`.
 * @since 0.14.0
 */
export const HARD_FLOOR_NODE = '22.9.0';

/**
 * Checks the measured startup floor before command modules can be loaded.
 *
 * @param version - Host Node version without a leading v
 * @returns Whether the recognizable numeric version is below the floor
 * @since 0.14.0
 */
export function isNodeBelowFloor(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  if (match === null) return false;
  const actual = match.slice(1, 4).map(Number);
  const floor = HARD_FLOOR_NODE.split('.').map(Number);
  for (const index of [0, 1, 2]) {
    if (actual[index] !== floor[index]) return actual[index]! < floor[index]!;
  }
  return false;
}

/**
 * Selects the shared startup refusal before either executable loads command modules.
 *
 * @param versions - Host process versions; a Bun version bypasses the Node floor
 * @param isDeno - Whether this host is Deno
 * @returns The exact refusal below the floor, or no refusal for other hosts
 * @example
 * nodeFloorRefusal({ node: '22.9.0' }, false); // undefined
 * @since 0.14.0
 */
export function nodeFloorRefusal(
  versions: Readonly<Record<string, string | undefined>>,
  isDeno: boolean,
): string | undefined {
  const version = versions.node;
  if (versions.bun !== undefined || isDeno || version === undefined || !isNodeBelowFloor(version))
    return undefined;
  return `setu needs Node ${HARD_FLOOR_NODE} or newer; this is Node ${version}. Supported: ${SUPPORTED_NODE}.`;
}

/**
 * Tests a host version against the supported Node release lines.
 *
 * @param version - Node's three-component version, without a leading v
 * @returns Whether the version satisfies SUPPORTED_NODE
 * @since 0.14.0
 */
export function isSupportedNode(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (match === null) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  return SUPPORTED_NODE.split(' || ').some((range) => {
    const lower = /^(\^|>=)(\d+)\.(\d+)\.(\d+)$/.exec(range)!;
    const lowerMajor = Number(lower[2]);
    const lowerMinor = Number(lower[3]);
    const lowerPatch = Number(lower[4]);
    if (lower[1] === '^' && major !== lowerMajor) return false;
    return (
      major > lowerMajor ||
      (major === lowerMajor &&
        (minor > lowerMinor || (minor === lowerMinor && patch >= lowerPatch)))
    );
  });
}
