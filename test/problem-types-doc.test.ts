/** Problem-type documentation agrees with the errors the server actually constructs. */
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import {
  DATABASE_PROBLEM_TYPES,
  DuplicateKeyError,
  InvalidFieldValueError,
  httpStatusHintOf,
} from '@setu-ts/common';
import {
  SerializationConflictError,
  VersionConflictError,
  ForeignKeyViolationError,
  NotNullViolationError,
  DatabaseUnavailableError,
  DatabaseTimeoutError,
} from '@setu-ts/database-plugin';

it('documents all eleven statuses, titles, classes and reasons from their real hints', async () => {
  const guide = await readFile('docs/problem-types.md', 'utf8');
  const errors = [
    new SerializationConflictError('diagnostic'),
    new SerializationConflictError('diagnostic', { reason: 'lock-timeout' }),
    new VersionConflictError('diagnostic'),
    new DuplicateKeyError('diagnostic'),
    new ForeignKeyViolationError('diagnostic'),
    new NotNullViolationError('diagnostic'),
    new InvalidFieldValueError('Entity'),
    new DatabaseUnavailableError('diagnostic'),
    new DatabaseUnavailableError('diagnostic', { reason: 'pool-saturated' }),
    new DatabaseTimeoutError('diagnostic'),
    new DatabaseTimeoutError('diagnostic', { reason: 'connection-lost' }),
  ];
  const rows = guide.split('\n').filter((line) => line.startsWith('| `'));
  expect(rows).toHaveLength(Object.keys(DATABASE_PROBLEM_TYPES).length);
  for (const error of errors) {
    const hint = httpStatusHintOf(error)!;
    const problem = hint.problem!;
    const slug = problem.type.split('/').at(-1)!;
    const fields = rows
      .find((line) => line.startsWith('| `' + slug + '`'))!
      .split('|')
      .map((cell) => cell.trim());
    expect(fields[1]).toContain(problem.title);
    expect(fields[2]).toBe(String(hint.status));
    expect(fields[3]).toContain(error.name);
    if ('reason' in error) expect(fields[3]).toContain(String(error.reason));
    else expect(fields[3]).toContain('no reason field');
  }
  const example: unknown = JSON.parse(guide.match(/```json\n([\s\S]*?)\n```/)![1]!);
  const version = httpStatusHintOf(new VersionConflictError('diagnostic'))!;
  expect(example).toEqual({ ...version.problem, status: version.status, detail: version.detail });
  expect(example).not.toHaveProperty('message');
});
