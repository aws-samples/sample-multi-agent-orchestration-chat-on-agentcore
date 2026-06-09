/**
 * Jest globalTeardown for repository integration tests.
 * Stops the DynamoDB Local container started in global-setup.
 */

import type { StartedTestContainer } from 'testcontainers';

declare global {
  var __DDB_CONTAINER__: StartedTestContainer | undefined;
}

export default async function globalTeardown(): Promise<void> {
  const container = globalThis.__DDB_CONTAINER__;
  if (!container) {
    return;
  }
  // Best-effort stop: never let a teardown failure fail the run. If stop()
  // rejects (Docker hiccup / already-removed), warn so a possibly-leaked
  // container is visible; the testcontainers Ryuk reaper is the backstop.
  try {
    await container.stop();
    console.log('[ddb-local] stopped');
  } catch (error) {
    console.warn('[ddb-local] failed to stop container (may need manual cleanup):', error);
  }
}
