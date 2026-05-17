/**
 * Dependency interfaces for SessionPersistenceHook
 *
 * These interfaces decouple session/ from services/ by defining
 * the contracts that session-persistence-hook.ts needs, without
 * requiring it to import concrete service implementations.
 *
 * The concrete implementations live in services/ and are injected
 * at construction time by the caller (e.g., sub-agent-task-manager).
 */

export interface ISessionsService {
  isConfigured(): boolean;
  sessionExists(userId: string, sessionId: string): Promise<boolean>;
  createSession(params: {
    userId: string;
    sessionId: string;
    title: string;
    agentId?: string;
    storagePath?: string;
    sessionType?: string;
    /** Cognito User Pool sub — used for AppSync channel paths (no colons). */
    channelUserId?: string;
  }): Promise<unknown>;
  updateSessionAgentAndStorage(
    userId: string,
    sessionId: string,
    agentId?: string,
    storagePath?: string
  ): Promise<void>;
  updateSessionTimestamp(userId: string, sessionId: string): Promise<void>;
  updateSessionTitle(userId: string, sessionId: string, title: string): Promise<void>;
}

export interface ITitleGenerator {
  generateTitle(userMessage: string, assistantMessage: string): Promise<string>;
}

export interface MessageEvent {
  type: 'MESSAGE_ADDED' | 'AGENT_COMPLETE' | 'AGENT_ERROR';
  sessionId: string;
  message?: {
    role: 'user' | 'assistant';
    content: unknown[];
    timestamp: string;
  };
  error?: string;
}

export type PublishMessageEventFn = (
  userId: string,
  sessionId: string,
  event: MessageEvent
) => Promise<void>;

export interface SessionPersistenceDeps {
  getSessionsService: () => ISessionsService;
  getTitleGenerator: () => ITitleGenerator;
  publishMessageEvent: PublishMessageEventFn;
}
