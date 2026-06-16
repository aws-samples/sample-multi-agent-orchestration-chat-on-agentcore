/**
 * DynamoDB implementation of the triggers repository — internal entry point.
 *
 * Only the composition root (`../triggers-repository.factory.ts`) and the
 * implementation's own integration tests import from here. Application code
 * depends on the `TriggersRepository` interface from the parent barrel instead.
 */

export { DynamoDBTriggersRepository } from './repository.js';
