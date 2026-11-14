import process from 'node:process';
import { nodeProcess, nodeRuntime, runMain } from './main.ts';

process.exitCode = await runMain(nodeRuntime(), nodeProcess());
