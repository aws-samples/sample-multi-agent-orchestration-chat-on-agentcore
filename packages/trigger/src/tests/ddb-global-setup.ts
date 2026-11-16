/** Starts DynamoDB Local for *.ddb.integration.test.ts (npm run test:ddb). */
import { GenericContainer, type StartedTestContainer } from 'testcontainers';

declare global {
  var __DDB_CONTAINER__: StartedTestContainer | undefined;
}

export default async function globalSetup(): Promise<void> {
  const container = await new GenericContainer('amazon/dynamodb-local:2.5.2')
    .withExposedPorts(8000)
    .withCommand(['-jar', 'DynamoDBLocal.jar', '-inMemory', '-sharedDb'])
    .start();
  globalThis.__DDB_CONTAINER__ = container;
  process.env.DYNAMODB_ENDPOINT = `http://${container.getHost()}:${container.getMappedPort(8000)}`;
  // DynamoDB Local ignores credentials, but the SDK must sign with something.
  process.env.AWS_ACCESS_KEY_ID ||= 'local';
  process.env.AWS_SECRET_ACCESS_KEY ||= 'local';
  process.env.AWS_REGION ||= 'us-east-1';
}
