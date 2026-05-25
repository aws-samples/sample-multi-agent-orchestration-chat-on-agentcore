/**
 * Session persistence hook
 *
 * Plugin (formerly HookProvider in `@strands-agents/sdk@<0.7.0`) that
 * automatically saves conversation history before and after Agent execution.
 * Also manages session metadata in DynamoDB and generates AI-powered titles.
 */

import { AfterInvocationEvent, MessageAddedEvent, Message } from '@strands-agents/sdk';
import type { Plugin, LocalAgent } from '@strands-agents/sdk';
import { SessionConfig, SessionStorage } from './types.js';
import type { SessionPersistenceDeps } from '../../types/session-persistence-deps.js';
import { createLogger } from '../../libs/logger/index.js';
import { getCurrentContext } from '../../libs/context/request-context.js';
import { contentBlockToWire } from '../../libs/codec/content-block-codec.js';

const log = createLogger('SessionPersistenceHook');
/**
 * Extract title from first user message (truncate to max 50 chars)
 * Used as temporary title before AI generation
 */
function extractTitleFromMessage(message: Message): string {
  const maxLength = 50;

  if (message.role !== 'user') {
    return 'Session';
  }

  const text = extractTextFromMessage(message);
  if (!text) {
    return 'Session';
  }

  return text.length > maxLength ? text.substring(0, maxLength) + '...' : text;
}

/**
 * Extract text content from a message
 */
function extractTextFromMessage(message: Message): string {
  const content = message.content;
  if (!content || !Array.isArray(content)) {
    return '';
  }

  for (const block of content) {
    if (block && typeof block === 'object' && 'text' in block && typeof block.text === 'string') {
      const text = block.text.trim();
      if (text) {
        return text;
      }
    }
  }

  return '';
}

/**
 * Plugin that persists session history in response to Agent lifecycle events.
 * Also creates/updates session metadata in DynamoDB and generates AI-powered titles.
 *
 * Migrated from `HookProvider` to `Plugin` for `@strands-agents/sdk@>=0.7.0`.
 *
 * Usage:
 * const hook = new SessionPersistenceHook(storage, { actorId: "user123", sessionId: "session456" });
 * const agent = new Agent({ plugins: [hook] });
 */
export class SessionPersistenceHook implements Plugin {
  readonly name = 'moca:session-persistence-hook';
  private isFirstUserMessage = true;
  private isNewSession = false;
  private firstUserMessageText?: string;
  private agentId?: string;
  private storagePath?: string;

  constructor(
    private readonly storage: SessionStorage,
    private readonly sessionConfig: SessionConfig,
    private readonly deps: SessionPersistenceDeps,
    agentId?: string,
    storagePath?: string
  ) {
    this.agentId = agentId;
    this.storagePath = storagePath;
  }

  /**
   * Register hook callbacks on the agent.
   * Called by the Agent's PluginRegistry during construction.
   */
  initAgent(agent: LocalAgent): void {
    // Handle message added events for DynamoDB session management
    agent.addHook(MessageAddedEvent, (event) => this.onMessageAdded(event));

    // Save history after Agent execution completes
    agent.addHook(AfterInvocationEvent, (event) => this.onAfterInvocation(event));
  }

  /**
   * Event handler when a message is added
   * 1. Saves message content to AgentCore Memory in real-time (for both invoke() and stream() modes)
   * 2. Creates session in DynamoDB on first user message, updates timestamp on subsequent messages
   * 3. Triggers async title generation on first assistant message for new sessions
   */
  private async onMessageAdded(event: MessageAddedEvent): Promise<void> {
    const message = event.message;
    const { actorId, sessionId } = this.sessionConfig;

    // Real-time message persistence to AgentCore Memory
    // This ensures messages are saved immediately for both invoke() and stream() modes,
    // which is critical for sub-agent tasks that use invoke() and previously only saved
    // messages on AfterInvocationEvent (i.e., only after the entire session completed).
    try {
      await this.storage.appendMessage(this.sessionConfig, message);
      log.debug(
        { sessionId, role: message.role, contentBlocks: message.content.length },
        'Message saved in real-time'
      );
    } catch (error) {
      // Non-blocking: AfterInvocationEvent fallback will attempt to save all unsaved messages
      log.warn(
        {
          sessionId,
          role: message.role,
          error,
        },
        'Real-time message save failed (non-blocking):'
      );
    }

    // DynamoDB session metadata management
    // This must run BEFORE AppSync publish so that when the frontend receives
    // the notification, the session record (agentId, storagePath, title) already
    // exists in DynamoDB and can be loaded by the UI.
    const sessionsService = this.deps.getSessionsService();
    if (!sessionsService.isConfigured()) {
      log.debug('SessionsService not configured, skipping DynamoDB operation');
      // Still publish to AppSync even if DynamoDB is not configured
      this.publishMessage(actorId, sessionId, message);
      return;
    }

    // Handle user messages
    if (message.role === 'user') {
      try {
        if (this.isFirstUserMessage) {
          // Check if session already exists
          const exists = await sessionsService.sessionExists(actorId, sessionId);

          if (!exists) {
            // New session - create in DynamoDB with temporary title
            const title = extractTitleFromMessage(message);
            await sessionsService.createSession({
              userId: actorId,
              sessionId,
              title,
              agentId: this.agentId,
              storagePath: this.storagePath,
              sessionType: this.sessionConfig.sessionType,
              // Store the User Pool sub so that session-stream-handler can
              // build AppSync channel paths without a colon (identityId has REGION:UUID).
              channelUserId: getCurrentContext()?.userId,
            });
            // Note: SessionsService.createSession emits its own "Created session" log,
            // so we skip the duplicate here.

            // Mark as new session and save user message for title generation
            this.isNewSession = true;
            this.firstUserMessageText = extractTextFromMessage(message);
          } else {
            // Existing session - update agentId, storagePath and timestamp
            await sessionsService.updateSessionAgentAndStorage(
              actorId,
              sessionId,
              this.agentId,
              this.storagePath
            );
            log.debug(
              {
                userId: actorId,
                sessionId,
                agentId: this.agentId,
                storagePath: this.storagePath,
              },
              'Updated existing session agent/storage:'
            );
          }

          this.isFirstUserMessage = false;
        } else {
          // Subsequent messages - just update timestamp
          await sessionsService.updateSessionTimestamp(actorId, sessionId);
          log.debug(
            {
              userId: actorId,
              sessionId,
            },
            'Updated session timestamp:'
          );
        }
      } catch (error) {
        log.warn(
          {
            userId: actorId,
            sessionId,
            error,
          },
          'DynamoDB operation failed:'
        );
      }
      // Publish after DynamoDB session creation/update completes
      this.publishMessage(actorId, sessionId, message);
      return;
    }

    // Handle assistant messages - trigger title generation for new sessions
    if (message.role === 'assistant' && this.isNewSession && this.firstUserMessageText) {
      const assistantText = extractTextFromMessage(message);

      // Trigger async title generation (don't await)
      this.generateTitleAsync(actorId, sessionId, this.firstUserMessageText, assistantText);

      // Reset flags to prevent duplicate generation
      this.isNewSession = false;
      this.firstUserMessageText = undefined;
    }

    // Publish for non-user messages (assistant, etc.)
    this.publishMessage(actorId, sessionId, message);
  }

  /**
   * Publish message to AppSync Events for cross-tab/cross-device sync.
   * This runs for both main agents (stream mode) and sub-agents (invoke mode),
   * ensuring real-time UI updates regardless of execution mode.
   *
   * AppSync channel path: /messages/{userId}/{sessionId}
   * Uses userId (Cognito User Pool sub, UUID format, no colons) — NOT identityId
   * (REGION:UUID format) — because AppSync channel paths do not allow colons.
   */
  private publishMessage(actorId: string, sessionId: string, message: Message): void {
    // Use the Cognito User Pool sub (context.userId) for the AppSync channel path.
    // actorId is the Identity Pool identityId (REGION:UUID) used for DynamoDB/Memory,
    // but AppSync channel paths reject colons — so fall back to actorId only if no
    // context userId is available (e.g. sub-agent without request context).
    const channelUserId = getCurrentContext()?.userId ?? actorId;

    // Convert SDK ContentBlock instances to wire format BEFORE serialisation.
    //
    // WHY: Strands SDK `ContentBlock` classes implement `toJSON()` that emits the
    // Bedrock Converse-API native shape (`{ toolUse: {...} }`, `{ toolResult: {...} }`)
    // and DROPS the `type` discriminator. Letting `JSON.stringify` (called inside
    // `appsync-events-publisher`) invoke that toJSON would deliver `type`-less blocks
    // to the frontend, which then falls through to the "Unsupported content type"
    // branch in `Message.tsx` because `convertContent` in
    // `useMessageEventsSubscription` dispatches on `content.type`.
    //
    // The codec used here is the same one used for DynamoDB / AgentCore Memory
    // persistence, keeping the wire shape consistent across all egress paths.
    const wireContent = message.content.map(contentBlockToWire);

    this.deps
      .publishMessageEvent(channelUserId, sessionId, {
        type: 'MESSAGE_ADDED',
        sessionId,
        message: {
          role: message.role as 'user' | 'assistant',
          content: wireContent,
          timestamp: new Date().toISOString(),
        },
      })
      .catch((err) => {
        log.warn({ err: err }, 'AppSync Events publish failed (non-critical):');
      });
  }

  /**
   * Generate title asynchronously and update DynamoDB
   * This runs in background without blocking the main response stream
   */
  private async generateTitleAsync(
    userId: string,
    sessionId: string,
    userMessage: string,
    assistantMessage: string
  ): Promise<void> {
    try {
      log.debug(
        {
          userId,
          sessionId,
          userMessageLength: userMessage.length,
          assistantMessageLength: assistantMessage.length,
        },
        'Starting async title generation'
      );

      const titleGenerator = this.deps.getTitleGenerator();
      const title = await titleGenerator.generateTitle(userMessage, assistantMessage);

      const sessionsService = this.deps.getSessionsService();
      await sessionsService.updateSessionTitle(userId, sessionId, title);
      // Note: SessionsService.updateSessionTitle emits "Updated session title";
      // we skip the duplicate "Title generated and saved" here.
    } catch (error) {
      // Log warning but don't throw - keep temporary title
      log.warn(
        {
          userId,
          sessionId,
          error,
        },
        'Failed to generate title, keeping temporary title:'
      );
    }
  }

  /**
   * Event handler after Agent execution completes
   * Save conversation history to storage
   * Fallback for when real-time saving is not performed
   */
  private async onAfterInvocation(event: AfterInvocationEvent): Promise<void> {
    const { actorId, sessionId } = this.sessionConfig;
    try {
      const messages = event.agent.messages;

      log.debug(
        { actorId, sessionId },
        `AfterInvocation triggered: Agent messages=${messages.length}, checking for unsaved messages`
      );

      // Save conversation history to storage (avoid duplicates if already saved)
      await this.storage.saveMessages(this.sessionConfig, messages);

      log.debug(
        `Session history auto-save completed (fallback): ${actorId}/${sessionId} (${messages.length} items)`
      );
    } catch (error) {
      // Log at warning level to not stop Agent execution even if error occurs
      log.warn({ err: error }, `Session history auto-save failed: ${actorId}/${sessionId}`);
    } finally {
      // Notify frontend that the agent has finished processing.
      // Use context.userId (User Pool sub, UUID) for the AppSync channel — not actorId
      // (identityId, REGION:UUID) which contains colons that AppSync rejects.
      const channelUserId = getCurrentContext()?.userId ?? actorId;
      this.deps
        .publishMessageEvent(channelUserId, sessionId, {
          type: 'AGENT_COMPLETE',
          sessionId,
        })
        .catch((err) => {
          log.warn({ err: err }, 'Failed to publish AGENT_COMPLETE (non-critical):');
        });
    }
  }
}
