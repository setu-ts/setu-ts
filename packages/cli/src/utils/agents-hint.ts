/** Advisory reminder shared by commands that change agent-brief inputs. @module */
import type { IFileSystem } from '@setu-ts/common';
import type { TargetRuntime } from '../constants.ts';
import { BRIEF_BEGIN } from '../agents/brief-file.ts';
import { cliInvocation } from '../templates/project-files.ts';
import { joinPath, readExistingText } from './file-writer.ts';
import { escapeName } from './names.ts';

/**
 * A successful write stays successful when its advisory brief cannot be read.
 * @returns Whether a reminder was printed, so workspace callers can print it once.
 */
export async function reportAgentsHint(
  deps: {
    readonly fs: IFileSystem;
    readonly log: (line: string) => void;
    readonly error: (line: string) => void;
  },
  dir: string,
  runtime: TargetRuntime,
): Promise<boolean> {
  try {
    const brief = await readExistingText(deps.fs, joinPath(dir, 'AGENTS.md'));
    if (brief?.includes(BRIEF_BEGIN) === true) {
      deps.log(
        `Run \`${cliInvocation(runtime)} agents\` to update AGENTS.md. Check freshness with \`${cliInvocation(runtime)} agents --check\`.`,
      );
      return true;
    }
  } catch (cause) {
    deps.error(`Cannot inspect AGENTS.md: ${escapeName(String(cause))}`);
  }
  return false;
}
