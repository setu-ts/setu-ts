/** Append generated signing secrets to the ignored Kubernetes operator values. @module */

import type { IFileSystem } from '@setu-ts/common';
import { parseEnv } from '@setu-ts/common';
import { generateSecret } from '../templates/secret.ts';
import {
  assertInsideProject,
  type GeneratedFile,
  joinPath,
  readExistingText,
} from '../utils/file-writer.ts';
import { secretValuesPath } from './secrets.ts';

/**
 * Plans an exact-key append, preserving operator values and all existing text.
 * The returned file joins the caller's regular, rollback-capable write batch.
 *
 * @param fs - The command's filesystem
 * @param root - Absolute workspace root
 * @param member - Validated workspace member name
 * @param names - Names newly recorded in generatedSecrets
 * @param secret - Creates an independent value for each absent name
 * @returns The file to write (none when every name is present) and the names it appends
 * @throws {Error} When the path traverses a link or cannot be read safely
 * @since 0.13.0
 */
export async function operatorSecretFiles(
  fs: IFileSystem,
  root: string,
  member: string,
  names: readonly string[],
  secret: () => string = generateSecret,
): Promise<{ readonly files: readonly GeneratedFile[]; readonly appended: readonly string[] }> {
  const path = joinPath(root, secretValuesPath(member));
  await assertInsideProject(fs, root, path);
  const before = (await readExistingText(fs, path)) ?? '';
  const values = parseEnv(before);
  const missing = [...new Set(names)].filter((name) => !Object.hasOwn(values, name));
  if (missing.length === 0) return { files: [], appended: [] };
  const base = before === '' || before.endsWith('\n') ? before : `${before}\n`;
  return {
    files: [
      {
        path,
        contents: base + missing.map((name) => `${name}=${secret()}\n`).join(''),
        managed: true,
      },
    ],
    appended: missing,
  };
}
