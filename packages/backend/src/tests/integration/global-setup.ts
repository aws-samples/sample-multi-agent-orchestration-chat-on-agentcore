/**
 * Jest globalSetup for repository integration tests.
 *
 * Starts a throwaway `amazon/dynamodb-local` container via Testcontainers and
 * publishes its endpoint to `process.env.DYNAMODB_ENDPOINT`. jest forks test
 * workers AFTER globalSetup, so env vars set here are inherited by every
 * worker. The container handle is stashed on `globalThis` for globalTeardown
 * (both hooks run in the same jest parent process).
 *
 * We set only the AWS credential / region env vars the SDK needs to sign
 * requests against DynamoDB Local. We deliberately do NOT set the backend's
 * application env vars (TABLE_NAME / ARN / SSM prefix, validated by
 * `config/index.ts`): the repository layer under test is config-free, so these
 * suites must never import `config/index.ts`. If a future integration test
 * needs a module that pulls in config, set those placeholders here too — until
 * then, importing config would `process.exit(1)` and kill the worker.
 */

import { GenericContainer, type StartedTestContainer } from 'testcontainers';

const DDB_LOCAL_IMAGE = 'amazon/dynamodb-local:2.5.2';
const DDB_PORT = 8000;

declare global {
  var __DDB_CONTAINER__: StartedTestContainer | undefined;
}

export default async function globalSetup(): Promise<void> {
  const container = await new GenericContainer(DDB_LOCAL_IMAGE)
    .withExposedPorts(DDB_PORT)
    .withCommand(['-jar', 'DynamoDBLocal.jar', '-inMemory', '-sharedDb'])
    .start();

  const endpoint = `http://${container.getHost()}:${container.getMappedPort(DDB_PORT)}`;

  globalThis.__DDB_CONTAINER__ = container;
  process.env.DYNAMODB_ENDPOINT = endpoint;
  // DynamoDB Local ignores credentials, but the SDK still requires *some*
  // value to sign requests.
  process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID || 'local';
  process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY || 'local';
  process.env.AWS_REGION = process.env.AWS_REGION || 'us-east-1';

  console.log(`\n[ddb-local] started at ${endpoint}`);
}
