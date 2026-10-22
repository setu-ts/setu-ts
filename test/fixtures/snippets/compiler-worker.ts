import { parentPort } from 'node:worker_threads';
import { compileFenceInProcess } from './fence-engine.ts';
if (!parentPort) throw new Error('Fence compiler requires its parent port');
const port = parentPort;
const context = {};
port.on('message', (file: string) => {
  void compileFenceInProcess(file, context).then(
    (result) => port.postMessage(result),
    (error) => port.postMessage({ error: String(error) }),
  );
});
