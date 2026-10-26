/** Validated, project-local silencing. Invalid configuration suppresses nothing. @module */
import type { IFileSystem } from '@setu-ts/common';
import type { Finding } from './diagnose.ts';
import { FINDING_IDS, findingId, findingPath } from './ids.ts';
import { readBarrel } from './barrel-drift.ts';
import { joinPath } from '../utils/file-writer.ts';

const SILENCE_PATH = '.setu-ts/check.json';
type Entry = string | { readonly id: string; readonly path: string };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reads, validates and applies silence entries against the complete finding set. */
export async function readSilence(
  fs: IFileSystem,
  dir: string,
  findings: readonly Finding[],
): Promise<{ readonly findings: readonly Finding[]; readonly silenced: number }> {
  const invalid = (
    entry: string,
  ): { readonly findings: readonly Finding[]; readonly silenced: number } => ({
    findings: [...findings, { kind: 'check-config-invalid', path: SILENCE_PATH, entry }],
    silenced: 0,
  });
  const read = await readBarrel(fs, joinPath(dir, SILENCE_PATH));
  if (read.kind === 'absent') return { findings, silenced: 0 };
  if (read.kind === 'unreadable') return invalid(read.reason);
  let value: unknown;
  try {
    value = JSON.parse(read.source);
  } catch {
    return invalid('invalid JSON');
  }
  if (
    !record(value) ||
    Object.keys(value).some((key) => key !== 'silence') ||
    !Array.isArray(value.silence)
  )
    return invalid('expected only a silence array');
  const known = new Set<string>(
    Object.values(FINDING_IDS).flatMap((value) =>
      typeof value === 'string' ? [value] : Object.values(value),
    ),
  );
  const entries: Entry[] = [];
  for (const entry of value.silence as readonly unknown[]) {
    const id = typeof entry === 'string' ? entry : record(entry) ? entry.id : undefined;
    if (
      typeof id !== 'string' ||
      !known.has(id) ||
      id === FINDING_IDS['check-config-invalid'] ||
      id === FINDING_IDS['silence-unmatched']
    )
      return invalid(JSON.stringify(entry));
    if (typeof entry === 'string') entries.push(entry);
    else if (
      record(entry) &&
      Object.keys(entry).length === 2 &&
      typeof entry.path === 'string' &&
      entry.path.length > 0 &&
      !entry.path.startsWith('/') &&
      !entry.path.includes('\\') &&
      !entry.path.split('/').some((part) => part === '..' || part === '.' || part === '')
    )
      entries.push({ id, path: entry.path });
    else return invalid(JSON.stringify(entry));
  }
  const hidden = new Set<Finding>();
  const unmatched: Finding[] = [];
  for (const entry of entries) {
    const matches = findings.filter(
      (finding) =>
        findingId(finding) === (typeof entry === 'string' ? entry : entry.id) &&
        (typeof entry === 'string' || findingPath(finding) === entry.path),
    );
    if (matches.length === 0)
      unmatched.push({ kind: 'silence-unmatched', entry: JSON.stringify(entry) });
    for (const match of matches) hidden.add(match);
  }
  return {
    findings: [...findings.filter((finding) => !hidden.has(finding)), ...unmatched],
    silenced: hidden.size,
  };
}
