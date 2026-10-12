import { defineWorkerTask } from '@setu-ts/runtime/worker';

defineWorkerTask<{ buf: SharedArrayBuffer | ArrayBuffer; pattern: number }, number>(
  ({ buf, pattern }) => {
    const view = new Uint8Array(buf);
    view.fill(pattern);
    return view.length;
  },
);
