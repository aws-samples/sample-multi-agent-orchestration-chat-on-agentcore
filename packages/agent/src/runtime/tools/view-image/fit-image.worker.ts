/**
 * Worker-thread entry for fitImage. See fit-image-off-thread.ts.
 */

import { parentPort, workerData } from 'node:worker_threads';
import { messageOf } from '../../../libs/utils/error-message.js';
import { fitImage, type Region } from './fit-image.js';

interface Input {
  data: Uint8Array;
  format: Parameters<typeof fitImage>[0]['format'];
  region?: Region;
}

const { data, format, region } = workerData as Input;

fitImage({ data: Buffer.from(data.buffer, data.byteOffset, data.byteLength), format }, region).then(
  (fitted) => {
    // Copy into a standalone buffer so it can be transferred rather than cloned.
    const bytes = new Uint8Array(fitted.bytes);
    parentPort!.postMessage({ ok: true, fitted: { ...fitted, bytes } }, [bytes.buffer]);
  },
  (error: unknown) => {
    parentPort!.postMessage({ ok: false, message: messageOf(error) });
  }
);
