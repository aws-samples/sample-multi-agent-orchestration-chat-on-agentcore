/**
 * Run fitImage in a worker thread. The JS/WASM codecs decode synchronously, so
 * in-process a large image would block the event loop for seconds — stalling
 * the response stream, /ping, and any sub-agents sharing the process. A fresh
 * worker per call also hands the decoded bitmaps back to the OS when it exits.
 */

import { Worker } from 'node:worker_threads';
import type { ImageFormat } from '../../../libs/utils/image-source.js';
import type { FittedImage, Region } from './fit-image.js';

// The container runs compiled .js. From the .ts sources (`npm run dev`, jest)
// the worker goes through a bootstrap that registers tsx; jest's own transform
// does not reach worker threads.
const WORKER_URL = new URL(
  import.meta.url.endsWith('.ts') ? './fit-image.worker.dev.mjs' : './fit-image.worker.js',
  import.meta.url
);

type WorkerReply =
  { ok: true; fitted: FittedImage & { bytes: Uint8Array } } | { ok: false; message: string };

export function fitImageOffThread(
  source: { data: Buffer; format: ImageFormat },
  region?: Region
): Promise<FittedImage> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_URL, {
      workerData: { data: source.data, format: source.format, region },
    });
    let settled = false;
    worker.once('message', (reply: WorkerReply) => {
      settled = true;
      if (reply.ok) {
        resolve({ ...reply.fitted, bytes: Buffer.from(reply.fitted.bytes) });
      } else {
        reject(new Error(reply.message));
      }
    });
    worker.once('error', (error) => {
      settled = true;
      reject(error);
    });
    worker.once('exit', (code) => {
      if (!settled) reject(new Error(`Image worker exited with code ${code}`));
    });
  });
}
