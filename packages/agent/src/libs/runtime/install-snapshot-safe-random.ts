/**
 * Side-effect import: must be the first import of src/index.ts so the patch is
 * in place before any dependency caches a reference to the original crypto
 * functions (CJS `const { randomUUID } = require('crypto')` would not follow it).
 */
import { installSnapshotSafeRandom } from './snapshot-safe-random.js';

installSnapshotSafeRandom();
