// Worker entry when running from the .ts sources (`npm run dev`, jest). Node 22
// type-strips the .ts entry itself, so `--import tsx` in the worker's execArgv
// never gets to remap `./fit-image.js` to the .ts file; registering tsx here,
// before the import, does. The container runs the compiled fit-image.worker.js.
import { register } from 'tsx/esm/api';

register();
await import('./fit-image.worker.ts');
