// The command-line entry for Node and Bun: `node run-driver.ts <server URL>`.
// Kept out of driver.ts because worker.ts imports that module, and workerd
// evaluates an `import.meta.main` block there too (Wrangler 4.164.0), where
// there is no process argument to read.
import { exerciseRealtimeClients } from './driver.ts';

const baseUrl = process.argv[2];
if (baseUrl === undefined) throw new Error('Expected the realtime server URL.');
await exerciseRealtimeClients(baseUrl);
