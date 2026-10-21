/** Admit bare dependency names that are safe in both Markdown and card paths. */
export function isAgentPackageName(name: string): boolean {
  // The first character excludes `.` and `..`; compare the whole match because
  // JavaScript's `$` also matches just before a final newline.
  return /^[a-z0-9][a-z0-9._-]*$/.exec(name)?.[0] === name;
}
