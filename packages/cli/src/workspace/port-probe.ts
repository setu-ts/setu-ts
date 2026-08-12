/**
 * The bindability seam for workspace ports.
 *
 * @module
 */

/** Checks whether a port is currently bindable on the local loopback address. */
export type PortProbe = (port: number) => Promise<boolean>;

/** A probe used outside the process boundary, where no real socket may be opened. */
export const assumePortAvailable: PortProbe = (): Promise<boolean> => Promise.resolve(true);
