/**
 * Jest globalSetup for repository integration tests (agent package).
 *
 * Starts a throwaway `amazon/dynamodb-local` container via Testcontainers and
 * publishes its endpoint to `process.env.DYNAMODB_ENDPOINT`. jest forks test
 * workers AFTER globalSetup, so env vars set here are inherited by every
 * worker. The container handle is stashed on `globalThis` for globalTeardown.
 *
 * Unlike the backend harness this file is ESM (the agent jest config uses the
 * ts-jest ESM preset), but the logic is otherwise identical.
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
