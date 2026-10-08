import { defineWorkerTask } from '@setu-ts/runtime/worker';

defineWorkerTask<{ buf: SharedArrayBuffer | ArrayBuffer }, number>(({ buf }) => {
  new Uint8Array(buf).fill(42);
  return buf.byteLength;
});
