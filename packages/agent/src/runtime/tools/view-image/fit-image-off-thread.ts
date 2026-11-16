/**
 * Run fitImage in a worker thread. The JS/WASM codecs decode synchronously, so
 * in-process a large image would block the event loop for seconds — stalling
 * the response stream, /ping, and any sub-agents sharing the process. A fresh
 * worker per call also hands the decoded bitmaps back to the OS when it ends.
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

/**
 * One decode at a time. Tools run concurrently, and a 25 MP JPEG peaks near
 * 1 GB in the JS decoder, so a batch of photos in one assistant message would
 * otherwise multiply that inside the shared microVM.
 */
const MAX_CONCURRENT_WORKERS = 1;

/** Generous for a 25 MP decode on a busy 2-vCPU microVM; a stuck codec must not hold the turn. */
export const WORKER_TIMEOUT_MS = 60_000;

const CANCELLED_MESSAGE = 'Image processing was cancelled';

type WorkerReply =
  { ok: true; fitted: FittedImage & { bytes: Uint8Array } } | { ok: false; message: string };

let running = 0;
const waiting: Array<() => void> = [];

async function acquireSlot(signal?: AbortSignal): Promise<void> {
  if (running < MAX_CONCURRENT_WORKERS) {
    running++;
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const grant = () => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    const onAbort = () => {
      const index = waiting.indexOf(grant);
      if (index !== -1) waiting.splice(index, 1);
      reject(new Error(CANCELLED_MESSAGE));
    };
    waiting.push(grant);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function releaseSlot(): void {
  const next = waiting.shift();
  if (next) {
    next(); // the slot passes straight to the next caller
  } else {
    running--;
  }
}

function runWorker(
  source: { data: Buffer; format: ImageFormat },
  region: Region | undefined,
  options: { signal?: AbortSignal; timeoutMs: number }
): Promise<FittedImage> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_URL, {
      workerData: { data: source.data, format: source.format, region },
      // Not the parent's: in the container that carries ADOT's `--require
      // .../register`, which would boot a full OpenTelemetry SDK per image.
      execArgv: [],
    });

    let settled = false;
    const finish = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      // Do not wait for the worker to exit by itself: anything it left ref'd
      // would keep the thread and its decoded bitmaps alive.
      void worker.terminate();
      outcome();
    };
    const onAbort = () => finish(() => reject(new Error(CANCELLED_MESSAGE)));
    const timer = setTimeout(
      () =>
        finish(() =>
          reject(
            new Error(
              `Image processing took longer than ${options.timeoutMs / 1000}s and was stopped. ` +
                'Crop a smaller region or use a smaller image.'
            )
          )
        ),
      options.timeoutMs
    );
    options.signal?.addEventListener('abort', onAbort, { once: true });

    worker.once('message', (reply: WorkerReply) =>
      finish(() =>
        reply.ok
          ? resolve({ ...reply.fitted, bytes: Buffer.from(reply.fitted.bytes) })
          : reject(new Error(reply.message))
      )
    );
    worker.once('error', (error) => finish(() => reject(error)));
    worker.once('exit', (code) =>
      finish(() => reject(new Error(`Image worker exited with code ${code}`)))
    );
  });
}

export async function fitImageOffThread(
  source: { data: Buffer; format: ImageFormat },
  region?: Region,
  options: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<FittedImage> {
  if (options.signal?.aborted) {
    throw new Error(CANCELLED_MESSAGE);
  }
  await acquireSlot(options.signal);
  try {
    // The abort may have fired while waiting for the slot, before runWorker listens.
    if (options.signal?.aborted) {
      throw new Error(CANCELLED_MESSAGE);
    }
    return await runWorker(source, region, {
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? WORKER_TIMEOUT_MS,
    });
  } finally {
    releaseSlot();
  }
}
