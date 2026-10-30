/** Extracts inline, reference-definition, autolink and HTML links outside fenced code. */
export function markdownLinks(markdown: string): string[] {
  const source = markdown.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1\s*$/gm, '');
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
