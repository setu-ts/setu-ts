/**
 * Removes fenced code blocks by CommonMark's rules: an opener indented up to three spaces, closed by
 * a line of the same character at least as long, with nothing after it but whitespace.
 */
function stripFences(markdown: string): string {
  const kept: string[] = [];
  let open: { char: string; length: number } | undefined;
  for (const line of markdown.split('\n')) {
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (open === undefined) {
      // A backtick fence's info string cannot contain a backtick.
      if (fence !== null && !(fence[1][0] === '`' && fence[2].includes('`'))) {
        open = { char: fence[1][0], length: fence[1].length };
      } else {
        kept.push(line);
      }
    } else if (
      fence !== null &&
      fence[1][0] === open.char &&
      fence[1].length >= open.length &&
      fence[2].trim() === ''
    ) {
      open = undefined;
    }
  }
  return kept.join('\n');
}

/** Extracts inline, reference-definition, autolink and HTML links outside fenced code. */
export function markdownLinks(markdown: string): string[] {
  const source = stripFences(markdown);
  return [
    ...[...source.matchAll(/(?<!!)\[[^\]]*\]\(<?([^\s)>]+)>?(?:\s+[^)]*)?\)/g)].map(
      (match) => match[1],
    ),
    ...[...source.matchAll(/^\s*\[[^\]]+\]:\s*<?([^\s>]+)>?/gm)].map((match) => match[1]),
    ...[...source.matchAll(/\bhref=["']([^"']+)["']/g)].map((match) => match[1]),
    ...[...source.matchAll(/<(https?:\/\/[^>]+)>/g)].map((match) => match[1]),
  ];
}

/** Actual link-tag hrefs emitted by Astro and TypeDoc, including their fragments and queries. */
export function htmlLinks(html: string): string[] {
  return [...html.matchAll(/<(?:a|link|area)\b[^>]*\shref=(["'])(.*?)\1[^>]*>/gi)].map(
    (match) => match[2],
  );
}
