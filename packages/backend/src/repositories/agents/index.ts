/**
 * Agents repository — public barrel.
 *
 * Application code imports the `AgentsRepository` contract and its method
 * input/output types from here, and obtains an instance from
 * `./agents-repository.factory.ts`. The `./dynamodb/` implementation is
 * private to the composition root.
 */

export type {
  AgentsRepository,
  UpdateAgentPatch,
  SharedAgentsPage,
} from './agents-repository.js';
