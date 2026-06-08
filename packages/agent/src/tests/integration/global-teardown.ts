/**
 * Jest globalTeardown for repository integration tests (agent package).
 * Stops the DynamoDB Local container started in global-setup.
 */

import type { StartedTestContainer } from 'testcontainers';

declare global {
  var __DDB_CONTAINER__: StartedTestContainer | undefined;
}

export default async function globalTeardown(): Promise<void> {
  const container = globalThis.__DDB_CONTAINER__;
  if (container) {
    await container.stop();
    console.log('[ddb-local] stopped');
  }
}
