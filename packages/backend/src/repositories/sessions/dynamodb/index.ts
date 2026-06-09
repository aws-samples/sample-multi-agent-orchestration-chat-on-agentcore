/**
 * DynamoDB implementation of the sessions repository — internal entry point.
 *
 * Only the composition root (`services/sessions-repository.factory.ts`) and the
 * implementation's own integration tests import from here. Application code
 * depends on the `SessionsRepository` interface from the parent barrel instead.
 */

export { DynamoDBSessionsRepository } from './repository.js';
