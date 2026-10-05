/** Real process-boundary fixture: pause after the seventeenth real write. */
import { createDenoRuntimeServices } from '@setu-ts/runtime';
import { denoProcess, runMain } from '../../src/main.ts';

const runtime = createDenoRuntimeServices();
const fs = runtime.fs!;
let writes = 0;
const slowed = {
  ...runtime,
  fs: {
    ...fs,
    async writeFile(path: string, data: Uint8Array): Promise<void> {
      await fs.writeFile(path, data);
      writes += 1;
      if (writes === 17) {
        console.log('WRITE17');
        await new Promise<void>((resolve) => runtime.setTimeout(resolve, 250));
      }
    },
  },
};
const { onSignal, ...unhandled } = slowed;
if (onSignal === undefined) throw new Error('SIGINT fixture requires runtime signal support');
// This is the permanent negative control for Deno's default SIGINT termination.
const selected = Deno.args[1] === 'unhandled' ? unhandled : { ...unhandled, onSignal };
Deno.exit(
  await runMain(selected, {
    ...denoProcess(),
    args: ['new', 'app', '--template', 'full-stack', '--yes'],
    cwd: () => Deno.args[0]!,
    log: () => {},
  }),
);
