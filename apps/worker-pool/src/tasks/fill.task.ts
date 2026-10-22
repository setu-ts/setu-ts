import { defineWorkerTask } from '@setu-ts/runtime/worker';

/** The input `fill` receives: a buffer to write into and the byte to write. */
export interface FillInput {
  readonly buf: SharedArrayBuffer | ArrayBuffer;
  readonly pattern: number;
}

/** Fills the buffer with one byte value and returns how many bytes it wrote. */
defineWorkerTask<FillInput, number>(({ buf, pattern }) => {
  const view = new Uint8Array(buf);
  view.fill(pattern);
  return view.length;
});
