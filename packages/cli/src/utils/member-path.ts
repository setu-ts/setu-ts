/** Normalizes separators for member comparison without changing POSIX filename characters. */
export function memberPath(path: string): string {
  const windows = /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\');
  return (windows ? path.replaceAll('\\', '/') : path).replace(/\/+$/, '');
}
