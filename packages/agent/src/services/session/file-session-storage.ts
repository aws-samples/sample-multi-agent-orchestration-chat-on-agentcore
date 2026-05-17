/**
 * File system-based session storage implementation
 * For development and testing. DynamoDB or AgentCore Memory recommended for production
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { Message } from '@strands-agents/sdk';
import { SessionConfig, SessionStorage } from './types.js';
import { logger, createLogger } from '../../libs/logger/index.js';

const log = createLogger('FileSessionStorage');

/**
 * Class for managing session history with local filesystem
 *
 * File structure:
 * {storageDir}/
 * └── {actorId}/
 *     └── {sessionId}.json
 *
 * Example:
 * sessions/
 * ├── engineer_alice/
 * │   ├── python_study_20250817.json
 * │   └── aws_session_20250818.json
 * └── user_bob/
 *     └── general_chat_20250817.json
 */
export class FileSessionStorage implements SessionStorage {
  constructor(private readonly storageDir: string = './sessions') {}

  /**
   * Load conversation history for specified session
   */
  async loadMessages(config: SessionConfig): Promise<Message[]> {
    const filePath = this.getFilePath(config);

    try {
      const data = await fs.readFile(filePath, 'utf-8');
      const messages = JSON.parse(data) as Message[];

      logger.debug(
        `Session history loaded: ${config.actorId}/${config.sessionId} (${messages.length} items)`
      );
      return messages;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // Return empty array if file doesn't exist (new session)
        logger.debug(`New session: ${config.actorId}/${config.sessionId}`);
        return [];
      } else {
        logger.error(
          { err: error },
          `Session history load error: ${config.actorId}/${config.sessionId}`
        );
        throw error;
      }
    }
  }

  /**
   * Save conversation history to specified session
   */
  async saveMessages(config: SessionConfig, messages: Message[]): Promise<void> {
    const actorDir = this.getActorDir(config.actorId);
    const filePath = this.getFilePath(config);

    try {
      // Create actor directory
      await fs.mkdir(actorDir, { recursive: true });

      // Save messages to JSON file (with indentation for readability)
      await fs.writeFile(filePath, JSON.stringify(messages, null, 2), 'utf-8');

      logger.debug(
        `Session history saved: ${config.actorId}/${config.sessionId} (${messages.length} items)`
      );
    } catch (error) {
      logger.error(
        { err: error },
        `Session history save error: ${config.actorId}/${config.sessionId}`
      );
      throw error;
    }
  }

  /**
   * Clear history for specified session
   * @param config Session configuration
   */
  async clearSession(config: SessionConfig): Promise<void> {
    const sessionPath = this.getFilePath(config);
    try {
      await fs.unlink(sessionPath);
      log.info(`Session cleared: ${sessionPath}`);
    } catch (error) {
      // Ignore if file doesn't exist
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.error({ err: error }, `Error clearing session:`);
        throw error;
      }
    }
  }

  /**
   * Append and save a single message to specified session
   * For real-time saving during streaming
   * @param config Session configuration
   * @param message Message to append
   */
  async appendMessage(config: SessionConfig, message: Message): Promise<void> {
    try {
      log.info(`Appending message for session: ${config.sessionId}, role: ${message.role}`);

      // Load existing messages
      const existingMessages = await this.loadMessages(config);

      // Add new message
      const updatedMessages = [...existingMessages, message];

      // Save updated messages
      await this.saveMessages(config, updatedMessages);
    } catch (error) {
      log.error({ err: error }, `Error appending message:`);
      throw error;
    }
  }

  /**
   * Get directory path for actor
   */
  private getActorDir(actorId: string): string {
    const safeActorId = this.sanitizeId(actorId);
    // nosemgrep: path-join-resolve-traversal - safeActorId is sanitized by sanitizeId()
    return path.join(this.storageDir, safeActorId);
  }

  /**
   * Get session file path
   */
  private getFilePath(config: SessionConfig): string {
    const safeActorId = this.sanitizeId(config.actorId);
    const safeSessionId = this.sanitizeId(config.sessionId);
    // nosemgrep: path-join-resolve-traversal - IDs are sanitized by sanitizeId()
    return path.join(this.storageDir, safeActorId, `${safeSessionId}.json`);
  }

  /**
   * Sanitize ID string to filesystem-safe format
   * Allowed characters: a-zA-Z0-9_-
   * Others replaced with _
   */
  private sanitizeId(id: string): string {
    if (!id) {
      throw new Error('ID cannot be empty string');
    }

    const sanitized = id.replace(/[^a-zA-Z0-9_-]/g, '_');

    // Limit length if too long (considering filesystem limitations)
    const maxLength = 100;
    if (sanitized.length > maxLength) {
      return sanitized.substring(0, maxLength);
    }

    return sanitized;
  }
}
