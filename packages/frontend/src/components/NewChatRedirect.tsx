import { useEffect } from 'react';
import { Navigate } from 'react-router-dom';
import { generateSessionId } from '../utils/sessionId';
import { logger } from '../utils/logger';

/**
 * Component that generates a new session ID and redirects when starting a new chat
 */
export function NewChatRedirect() {
  const sessionId = generateSessionId();

  useEffect(() => {
    logger.log(`Starting new session: ${sessionId}`);
  }, [sessionId]);

  return <Navigate to={`/chat/${sessionId}`} replace />;
}
