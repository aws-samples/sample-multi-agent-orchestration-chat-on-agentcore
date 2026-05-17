/**
 * Session-related type definitions
 *
 * Pure type definitions with no implementation logic.
 * Located in types/ (L0) so that all layers can depend on these types.
 */

import type { IdentityId, SessionId } from '@moca/core';

/**
 * Session type
 * - user: Normal conversation session by a user
 * - event: Automated execution session triggered by an event (e.g., EventBridge)
 * - subagent: Delegated execution session by a sub-agent
 */
export type SessionType = 'user' | 'event' | 'subagent';

/**
 * Session configuration
 * Follows the actor_id + session_id pattern of AgentCore Memory
 */
export interface SessionConfig {
  /**
   * Cognito Identity Pool identityId (format: "REGION:UUID") — NOT the
   * User Pool sub. AgentCore Memory and DynamoDB are both keyed on
   * identityId because the IAM policy variable
   * `${cognito-identity.amazonaws.com:sub}` (= identityId) is the one that
   * is correctly expanded against credentials issued via
   * GetCredentialsForIdentity.
   */
  actorId: IdentityId;
  /** ID that uniquely identifies the session — Branded type ensuring format validity */
  sessionId: SessionId;
  /** Session type (default: 'user') */
  sessionType?: SessionType;
}

/**
 * Interface for session storage
 * Abstraction to facilitate future replacement with DynamoDB or AgentCore Memory
 */
export interface SessionStorage {
  /**
   * Load conversation history for the specified session
   * @param config Session configuration
   * @returns Array of Message objects containing conversation history
   */
  loadMessages(config: SessionConfig): Promise<import('@strands-agents/sdk').Message[]>;

  /**
   * Save conversation history to the specified session
   * @param config Session configuration
   * @param messages Array of Message objects to save
   */
  saveMessages(
    config: SessionConfig,
    messages: import('@strands-agents/sdk').Message[]
  ): Promise<void>;

  /**
   * Clear the history for the specified session
   * @param config Session configuration
   */
  clearSession(config: SessionConfig): Promise<void>;

  /**
   * Append a single message to the specified session
   * For real-time saving during streaming
   * @param config Session configuration
   * @param message Message to append
   */
  appendMessage(
    config: SessionConfig,
    message: import('@strands-agents/sdk').Message
  ): Promise<void>;
}
