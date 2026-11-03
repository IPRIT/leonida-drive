// Run the shipped Web Worker entry in a real Node worker for transfer tests.
import { parentPort, workerData } from 'node:worker_threads';
globalThis.self = { postMessage: (message, transfer) => parentPort.postMessage(message, transfer) };
await import(workerData);
parentPort.on('message', (data) => self.onmessage({ data }));
