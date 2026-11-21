/** Host Node range matching for the CLI's startup warning. @module */

/** The Node engine range declared by both CLI executables. */
export const SUPPORTED_NODE = '^22.23.4 || ^24.22.1 || >=26.12.1';

/**
 * Tests a host version against the supported Node release lines.
 *
 * @param version - Node's three-component version, without a leading v
 * @returns Whether the version satisfies SUPPORTED_NODE
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
