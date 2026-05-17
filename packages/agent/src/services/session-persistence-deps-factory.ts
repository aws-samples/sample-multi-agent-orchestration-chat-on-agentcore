/**
 * Factory for SessionPersistenceDeps
 *
 * Provides the concrete service implementations that SessionPersistenceHook
 * needs, keeping the session/ layer decoupled from services/.
 */

import type { SessionPersistenceDeps } from '../types/session-persistence-deps.js';
import { getSessionsService } from './sessions-service.js';
import { getTitleGenerator } from './title-generator.js';
import { publishMessageEvent } from './appsync-events-publisher.js';

export function createSessionPersistenceDeps(): SessionPersistenceDeps {
  return {
    getSessionsService,
    getTitleGenerator,
    publishMessageEvent,
  };
}
