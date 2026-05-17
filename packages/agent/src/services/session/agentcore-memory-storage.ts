/**
 * Session storage implementation using AgentCore Memory
 */
import {
  BedrockAgentCoreClient,
  CreateEventCommand,
  DeleteEventCommand,
  paginateListEvents,
  type PayloadType,
} from '@aws-sdk/client-bedrock-agentcore';
import { Message } from '@strands-agents/sdk';
import type { SessionConfig, SessionStorage } from './types.js';
import {
  messageToAgentCorePayload,
  agentCorePayloadToMessage,
  extractEventId,
  getCurrentTimestamp,
  type AgentCorePayload,
} from './converters.js';
import { createLogger } from '../../libs/logger/index.js';

const log = createLogger('AgentCoreMemoryStorage');
/**
 * Session storage using AgentCore Memory
 */
export class AgentCoreMemoryStorage implements SessionStorage {
  private client: BedrockAgentCoreClient;
  private memoryId: string;

  /**
   * @param memoryId AgentCore Memory ID
   * @param client User-scoped BedrockAgentCoreClient (REQUIRED in production)
   */
  constructor(memoryId: string, client: BedrockAgentCoreClient) {
    this.client = client;
    this.memoryId = memoryId;
  }

  /**
   * Load conversation history for the specified session
   * @param config Session configuration
   * @returns Array of Message objects containing conversation history
   */
  async loadMessages(config: SessionConfig): Promise<Message[]> {
    try {
      log.debug(
        {
          sessionId: config.sessionId,
          actorId: config.actorId,
        },
        'Loading messages:'
      );

      // Pagination support: retrieve all events
      const allEvents = [];
      const paginator = paginateListEvents(
        { client: this.client },
        {
          memoryId: this.memoryId,
          actorId: config.actorId,
          sessionId: config.sessionId,
          includePayloads: true,
          maxResults: 100,
        }
      );

      for await (const page of paginator) {
        if (page.events) {
          allEvents.push(...page.events);
        }
      }

      if (allEvents.length === 0) {
        log.debug(
          {
            sessionId: config.sessionId,
          },
          'No events found:'
        );
        return [];
      }

      log.debug(
        {
          sessionId: config.sessionId,
          totalEvents: allEvents.length,
        },
        'Fetched all events:'
      );

      // Sort events in chronological order
      const sortedEvents = allEvents.sort((a, b) => {
        const timestampA = a.eventTimestamp ? new Date(a.eventTimestamp).getTime() : 0;
        const timestampB = b.eventTimestamp ? new Date(b.eventTimestamp).getTime() : 0;
        return timestampA - timestampB;
      });

      // Convert events to Messages
      const messages: Message[] = [];

      for (const event of sortedEvents) {
        if (event.payload && event.payload.length > 0) {
          // Consolidate multiple payloads within a single event into one message
          const consolidatedMessage = this.consolidateEventPayloads(event.payload);
          if (consolidatedMessage) {
            messages.push(consolidatedMessage);
          }
        }
      }

      log.debug(
        {
          sessionId: config.sessionId,
          messageCount: messages.length,
        },
        'Loaded messages:'
      );
      return messages;
    } catch (error) {
      log.error(
        {
          sessionId: config.sessionId,
          error,
        },
        'Error loading messages:'
      );
      throw error;
    }
  }

  /**
   * Save conversation history to the specified session
   * @param config Session configuration
   * @param messages Array of Message objects to save
   */
  async saveMessages(config: SessionConfig, messages: Message[]): Promise<void> {
    try {
      log.debug(
        {
          sessionId: config.sessionId,
          totalMessages: messages.length,
        },
        'Saving messages:'
      );

      // Get the number of existing messages
      const existingMessages = await this.loadMessages(config);
      const existingCount = existingMessages.length;

      // Extract only new messages
      const newMessages = messages.slice(existingCount);

      if (newMessages.length === 0) {
        log.debug(
          {
            sessionId: config.sessionId,
          },
          'No new messages to save:'
        );
        return;
      }

      log.debug(
        {
          sessionId: config.sessionId,
          newMessageCount: newMessages.length,
        },
        'Saving new messages:'
      );

      // Save each message as an individual event
      for (const message of newMessages) {
        await this.createMessageEvent(config, message);
      }
    } catch (error) {
      log.error(
        {
          sessionId: config.sessionId,
          error,
        },
        'Error saving messages:'
      );
      throw error;
    }
  }

  /**
   * Clear the history for the specified session
   * @param config Session configuration
   */
  async clearSession(config: SessionConfig): Promise<void> {
    try {
      log.debug(
        {
          sessionId: config.sessionId,
        },
        'Clearing session:'
      );

      // Pagination support: retrieve all events
      const allEvents = [];
      const paginator = paginateListEvents(
        { client: this.client },
        {
          memoryId: this.memoryId,
          actorId: config.actorId,
          sessionId: config.sessionId,
          includePayloads: false, // Retrieve event IDs only
          maxResults: 100,
        }
      );

      for await (const page of paginator) {
        if (page.events) {
          allEvents.push(...page.events);
        }
      }

      if (allEvents.length === 0) {
        log.debug(
          {
            sessionId: config.sessionId,
          },
          'No events to delete:'
        );
        return;
      }

      log.debug(
        {
          sessionId: config.sessionId,
          eventCount: allEvents.length,
        },
        'Deleting events:'
      );

      // Delete each event individually
      for (const event of allEvents) {
        const eventId = extractEventId(event);
        if (eventId) {
          await this.deleteEvent(config, eventId);
        }
      }
    } catch (error) {
      log.error(
        {
          sessionId: config.sessionId,
          error,
        },
        'Error clearing session:'
      );
      throw error;
    }
  }

  /**
   * Create a single message as an event
   * @param config Session configuration
   * @param message Message to save
   * @private
   */
  private async createMessageEvent(config: SessionConfig, message: Message): Promise<void> {
    const payload = messageToAgentCorePayload(message);

    const command = new CreateEventCommand({
      memoryId: this.memoryId,
      actorId: config.actorId,
      sessionId: config.sessionId,
      eventTimestamp: getCurrentTimestamp(),
      payload: [payload as PayloadType], // For type compatibility with AWS SDK's PayloadType
    });

    const response = await this.client.send(command);
    log.debug(
      {
        eventId: response.event?.eventId,
        messageRole: message.role,
      },
      'Created event:'
    );
  }

  /**
   * Append a single message to the specified session
   * For real-time saving during streaming
   * @param config Session configuration
   * @param message Message to append
   */
  async appendMessage(config: SessionConfig, message: Message): Promise<void> {
    try {
      log.debug(
        {
          sessionId: config.sessionId,
          messageRole: message.role,
        },
        'Appending message:'
      );

      await this.createMessageEvent(config, message);
    } catch (error) {
      log.error(
        {
          sessionId: config.sessionId,
          error,
        },
        'Error appending message:'
      );
      throw error;
    }
  }

  /**
   * Consolidate multiple payloads within an event into a single message
   * @param payloads Array of payloads within the event
   * @returns Consolidated Message, or null if consolidation fails
   * @private
   */
  private consolidateEventPayloads(payloads: PayloadType[]): Message | null {
    if (payloads.length === 0) return null;

    // Convert each payload to a message
    const messages: Message[] = [];
    for (const payloadItem of payloads) {
      if ('conversational' in payloadItem || 'blob' in payloadItem) {
        const agentCorePayload = payloadItem as AgentCorePayload;
        const message = agentCorePayloadToMessage(agentCorePayload);
        messages.push(message);
      }
    }

    if (messages.length === 0) return null;
    if (messages.length === 1) return messages[0];

    // Consolidate multiple messages
    // Merge content from messages with the same role
    const firstMessage = messages[0];
    const role = firstMessage.role;

    // Verify all messages have the same role
    const allSameRole = messages.every((msg) => msg.role === role);
    if (!allSameRole) {
      log.warn('Event contains mixed roles, using first message only');
      return firstMessage;
    }

    // Merge all content, dropping any blank textBlocks that would cause a Bedrock ValidationException
    const consolidatedContent = messages
      .flatMap((msg) => msg.content)
      .filter((block) => {
        if (block.type === 'textBlock' && 'text' in block) {
          return (block as { text: string }).text !== '';
        }
        return true;
      });

    log.debug(
      {
        role,
        payloadCount: payloads.length,
        contentBlockCount: consolidatedContent.length,
      },
      'Consolidated event payloads:'
    );

    return new Message({
      role,
      content: consolidatedContent,
    });
  }

  /**
   * Delete the specified event
   * @param config Session configuration
   * @param eventId ID of the event to delete
   * @private
   */
  private async deleteEvent(config: SessionConfig, eventId: string): Promise<void> {
    const command = new DeleteEventCommand({
      memoryId: this.memoryId,
      actorId: config.actorId,
      sessionId: config.sessionId,
      eventId: eventId,
    });

    await this.client.send(command);
    log.debug({ eventId }, 'Deleted event:');
  }
}
