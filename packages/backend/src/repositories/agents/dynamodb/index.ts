/**
 * DynamoDB implementation of the agents repository — internal entry point.
 *
 * Only the composition root (`../agents-repository.factory.ts`) and the
 * implementation's own tests import from here. Application code depends on the
 * `AgentsRepository` interface from the parent barrel instead.
 */

export { DynamoDBAgentsRepository } from './repository.js';
