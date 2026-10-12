/** E2E fixture: answers its task, then crashes asynchronously while idle. */
import { defineWorkerTask } from '@setu-ts/runtime/worker';

defineWorkerTask<number, number>((n) => {
  setTimeout(() => {
    throw new Error('fixture-idle-crash');
  }, 20);
  return n;
});
