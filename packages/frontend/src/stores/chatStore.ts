import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { randomId } from '../utils/randomId';
import type {
  ChatState,
  SessionChatState,
  Message,
  MessageContent,
  ToolUse,
  ToolResult,
  ImageAttachment,
} from '../types/index';
import { streamAgentResponse } from '../api/agent';
import type { ConversationMessage } from '../api/sessions';
import { useAgentStore } from './agentStore';
import { useStorageStore } from './storageStore';
import { useSessionStore } from './sessionStore';
import { useMemoryStore } from './memoryStore';
import { useSettingsStore } from './settingsStore';
import { logger } from '../utils/logger';

// Helper function: Convert image to Base64
const convertImageToBase64 = (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = reader.result as string;
      // Remove data:image/png;base64, prefix
      resolve(base64.split(',')[1]);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
};

// Helper function: Add MessageContent
const addContentToMessage = (
  contents: MessageContent[],
  newContent: MessageContent
): MessageContent[] => {
  return [...contents, newContent];
};

// Append a streaming delta to the trailing block of the given `kind`, or start
// a new block when the last block is a different kind (after a tool result, or
// when reasoning follows answer text and vice-versa).
//
// WHY this shape: the message `contents` array is the single source of truth for
// streaming accumulation. The previous design kept external `accumulatedContent`
// / `accumulatedReasoning` strings plus an `isAfterToolExecution` flag, and a
// second reasoning burst (think → tool → think → answer) re-used a stale
// accumulator, duplicating the earlier reasoning into the later panel. Reading
// and extending the trailing block removes that entire class of reset bugs.
const appendStreamingDelta = (
  contents: MessageContent[],
  kind: 'text' | 'reasoning',
  delta: string
): MessageContent[] => {
  const make = (text: string): MessageContent =>
    kind === 'text' ? { type: 'text', text } : { type: 'reasoning', reasoning: { text } };
  const textOf = (c: MessageContent): string =>
    c.type === 'text' ? (c.text ?? '') : (c.reasoning?.text ?? '');

  const lastContent = contents[contents.length - 1];
  // Extend the trailing block in place only when it is the same kind (streaming
  // continuation); otherwise start a fresh block so stream order is preserved.
  if (lastContent?.type === kind) {
    const updated = [...contents];
    updated[contents.length - 1] = make(textOf(lastContent) + delta);
    return updated;
  }
  return [...contents, make(delta)];
};

// Helper function: Update ToolUse status
const updateToolUseStatus = (
  contents: MessageContent[],
  toolUseId: string,
  status: ToolUse['status']
): MessageContent[] => {
  return contents.map((content) => {
    if (content.type === 'toolUse' && content.toolUse) {
      // Match by actual toolUseId or local ID
      if (content.toolUse.id === toolUseId || content.toolUse.originalToolUseId === toolUseId) {
        return {
          ...content,
          toolUse: {
            ...content.toolUse,
            status,
          },
        };
      }
    }
    return content;
  });
};

// Helper function: Create default session state
const createDefaultSessionState = (): SessionChatState => ({
  messages: [],
  isLoading: false,
  error: null,
  lastUpdated: new Date(),
});

// Helper function: Get session state (create if doesn't exist)
const getOrCreateSessionState = (
  sessions: Record<string, SessionChatState>,
  sessionId: string
): SessionChatState => {
  if (!sessions[sessionId]) {
    return createDefaultSessionState();
  }
  return sessions[sessionId];
};

interface ChatActions {
  getSessionState: (sessionId: string) => SessionChatState;
  getActiveSessionState: () => SessionChatState | null;
  switchSession: (sessionId: string) => void;
  addMessage: (sessionId: string, message: Omit<Message, 'id' | 'timestamp'>) => string;
  updateMessage: (sessionId: string, messageId: string, updates: Partial<Message>) => void;
  sendPrompt: (
    prompt: string,
    sessionId: string,
    images?: ImageAttachment[],
    goal?: string,
    goalJudgeModelId?: string,
    goalMaxAttempts?: number
  ) => Promise<void>;
  clearSession: (sessionId: string) => void;
  setLoading: (sessionId: string, loading: boolean) => void;
  setError: (sessionId: string, error: string | null) => void;
  clearError: (sessionId: string) => void;
  loadSessionHistory: (sessionId: string, conversationMessages: ConversationMessage[]) => void;
}

type ChatStore = ChatState & ChatActions;

export const useChatStore = create<ChatStore>()(
  devtools(
    (set, get) => ({
      // State
      sessions: {},
      activeSessionId: null,
      /**
       * WHY: lastStreamCompletedAt tracks per-session streaming completion time (epoch ms)
       *
       * This enables the grace-period guard in useMessageEventsSubscription.
       * After HTTP streaming completes (isLoading→false), AppSync events may
       * still arrive due to the async nature of publishMessageEvent() in the
       * agent handler (SigV4 signing + HTTPS POST).
       *
       * This field is tab-local (Zustand store is not shared across browser tabs):
       * - Sender tab: has timestamp → grace period active → skips AppSync events
       * - Other tabs: no timestamp → grace period inactive → receives events normally
       *
       * WHY NOT ref: We considered storing this in a React ref instead of Zustand
       * state, but the handler in useMessageEventsSubscription accesses chatStore
       * via getState() (not React hooks), so it must be in the store.
       */
      lastStreamCompletedAt: {},

      // Actions
      getSessionState: (sessionId: string) => {
        const { sessions } = get();
        return getOrCreateSessionState(sessions, sessionId);
      },

      getActiveSessionState: () => {
        const { sessions, activeSessionId } = get();
        if (!activeSessionId) return null;
        return getOrCreateSessionState(sessions, activeSessionId);
      },

      switchSession: (sessionId: string) => {
        set({ activeSessionId: sessionId });

        // Initialize session state if it doesn't exist
        const { sessions } = get();
        if (!sessions[sessionId]) {
          set({
            sessions: {
              ...sessions,
              [sessionId]: createDefaultSessionState(),
            },
          });
        }
        logger.log(`Session switched: ${sessionId}`);
      },

      addMessage: (sessionId: string, message: Omit<Message, 'id' | 'timestamp'>) => {
        const newMessage: Message = {
          ...message,
          id: randomId(),
          timestamp: new Date(),
        };

        const { sessions } = get();
        const sessionState = getOrCreateSessionState(sessions, sessionId);

        set({
          sessions: {
            ...sessions,
            [sessionId]: {
              ...sessionState,
              messages: [...sessionState.messages, newMessage],
              lastUpdated: new Date(),
            },
          },
        });

        return newMessage.id;
      },

      updateMessage: (sessionId: string, messageId: string, updates: Partial<Message>) => {
        const { sessions } = get();
        const sessionState = getOrCreateSessionState(sessions, sessionId);

        set({
          sessions: {
            ...sessions,
            [sessionId]: {
              ...sessionState,
              messages: sessionState.messages.map((msg) =>
                msg.id === messageId ? { ...msg, ...updates } : msg
              ),
              lastUpdated: new Date(),
            },
          },
        });
      },

      sendPrompt: async (
        prompt: string,
        sessionId: string,
        images?: ImageAttachment[],
        goal?: string,
        goalJudgeModelId?: string,
        goalMaxAttempts?: number
      ) => {
        const { addMessage, updateMessage, sessions } = get();

        // Per-message goal: applied only to this send. A whitespace-only goal is
        // treated as no goal; when there is no goal we also drop the judge model
        // and attempt cap so the wire body stays clean (agent falls back to
        // GOAL_JUDGE_MODEL_ID / GOAL_LOOP_MAX_ATTEMPTS).
        const trimmedGoal = goal?.trim() || undefined;
        const goalForConfig = trimmedGoal;
        const goalJudgeModelIdForConfig = trimmedGoal ? goalJudgeModelId : undefined;
        const goalMaxAttemptsForConfig = trimmedGoal ? goalMaxAttempts : undefined;

        // Set activeSessionId (for streaming callbacks to work correctly)
        set({ activeSessionId: sessionId });

        // Get/create session state
        const sessionState = getOrCreateSessionState(sessions, sessionId);

        // Set loading state
        set({
          sessions: {
            ...sessions,
            [sessionId]: {
              ...sessionState,
              isLoading: true,
              error: null,
            },
          },
        });

        // Check if it's a new session (for session list update)
        const sessionsStore = useSessionStore.getState().sessions;
        const isNewSession = !sessionsStore.some((s) => s.sessionId === sessionId);

        // For new sessions, optimistically add to sidebar immediately
        if (isNewSession) {
          const tempTitle = prompt.length > 30 ? prompt.substring(0, 30) + '...' : prompt;
          useSessionStore.getState().addOptimisticSession(sessionId, tempTitle);
        }

        try {
          // Build user message contents
          const userContents: MessageContent[] = [];

          // Add text
          if (prompt.trim()) {
            userContents.push({ type: 'text', text: prompt });
          }

          // Add images
          if (images && images.length > 0) {
            for (const image of images) {
              userContents.push({
                type: 'image',
                image: {
                  id: image.id,
                  fileName: image.fileName,
                  mimeType: image.mimeType,
                  size: image.size,
                  previewUrl: image.previewUrl,
                },
              });
            }
          }

          // Add user message
          addMessage(sessionId, {
            type: 'user',
            contents: userContents,
          });

          // Create assistant response message (for streaming)
          const assistantMessageId = addMessage(sessionId, {
            type: 'assistant',
            contents: [],
            isStreaming: true,
          });

          // Build a streaming-delta callback for the given block kind. Shared by
          // onTextDelta/onReasoningDelta so their session-scoping and append logic
          // stay in lockstep.
          const makeDeltaHandler = (kind: 'text' | 'reasoning') => (text: string) => {
            const { activeSessionId, sessions } = get();
            if (activeSessionId !== sessionId) {
              logger.log(
                `Session switch detected (${sessionId} → ${activeSessionId}), skipping ${kind} delta`
              );
              return;
            }
            const currentMessage = sessions[sessionId]?.messages.find(
              (msg) => msg.id === assistantMessageId
            );
            if (!currentMessage) return;
            updateMessage(sessionId, assistantMessageId, {
              contents: appendStreamingDelta(currentMessage.contents, kind, text),
              isStreaming: true,
            });
          };

          // Get selected agent configuration
          const selectedAgent = useAgentStore.getState().selectedAgent;

          // Get agent working directory
          const agentWorkingDirectory = useStorageStore.getState().agentWorkingDirectory;

          // Get long-term memory settings
          const { isMemoryEnabled } = useMemoryStore.getState();

          // Get selected model ID and its reasoning depth (per-model selection)
          const { selectedModelId, getReasoningDepthFor } = useSettingsStore.getState();
          const reasoningEffort = getReasoningDepthFor(selectedModelId);

          // Convert images to Base64
          let imageData: Array<{ base64: string; mimeType: string }> | undefined;
          if (images && images.length > 0) {
            imageData = await Promise.all(
              images
                .filter((img) => img.file)
                .map(async (img) => ({
                  base64: await convertImageToBase64(img.file!),
                  mimeType: img.mimeType,
                }))
            );
          }

          const agentConfig = selectedAgent
            ? {
                modelId: selectedModelId,
                reasoningEffort,
                systemPrompt: selectedAgent.systemPrompt,
                enabledTools: selectedAgent.enabledTools,
                storagePath: agentWorkingDirectory,
                agentId: selectedAgent.agentId,
                memoryEnabled: isMemoryEnabled,
                mcpConfig: selectedAgent.mcpConfig as Record<string, unknown> | undefined,
                images: imageData,
                goal: goalForConfig,
                goalJudgeModelId: goalJudgeModelIdForConfig,
                goalMaxAttempts: goalMaxAttemptsForConfig,
              }
            : {
                modelId: selectedModelId,
                reasoningEffort,
                storagePath: agentWorkingDirectory,
                memoryEnabled: isMemoryEnabled,
                images: imageData,
                goal: goalForConfig,
                goalJudgeModelId: goalJudgeModelIdForConfig,
                goalMaxAttempts: goalMaxAttemptsForConfig,
              };

          // Debug log
          if (selectedAgent) {
            logger.log(`Selected agent: ${selectedAgent.name}`);
            logger.log(`Enabled tools: ${selectedAgent.enabledTools.join(', ') || 'none'}`);
          } else {
            logger.log(`Using default agent`);
          }
          logger.log(`Agent working directory: ${agentWorkingDirectory}`);

          // Process streaming response
          await streamAgentResponse(
            prompt,
            sessionId,
            {
              // Text and reasoning deltas share the same accumulation path: scope
              // by session, find the streaming assistant message, append the delta
              // to its trailing block of the matching kind. A single factory keeps
              // the two callbacks from drifting (e.g. session-switch logging that
              // was previously only on the text path).
              //
              // Idempotency note: the SDK emits each `*ContentBlockDelta` as a pure
              // increment, never a cumulative resend, so appending is safe. There is
              // no live-stream replay path today; if one is ever added, dedup must
              // happen at the transport layer, not here (a content-level guard would
              // wrongly drop legitimately repeated tokens).
              onReasoningDelta: makeDeltaHandler('reasoning'),
              onTextDelta: makeDeltaHandler('text'),
              // GoalLoop retry boundary: the attempt just streamed failed the
              // judge and the agent is about to re-run. Reset the bubble so the
              // final attempt streams into an empty message — the live view then
              // converges on the persisted history, which keeps only
              // [input, final attempt] (intermediate attempts are internal).
              onGoalRetry: () => {
                const { activeSessionId } = get();
                if (activeSessionId !== sessionId) return;
                updateMessage(sessionId, assistantMessageId, {
                  contents: [],
                  isStreaming: true,
                });
              },
              onToolUse: (toolUse: ToolUse) => {
                const { activeSessionId, sessions } = get();
                if (activeSessionId !== sessionId) return;

                // Add tool use
                const sessionState = sessions[sessionId];
                if (!sessionState) return;

                const currentMessage = sessionState.messages.find(
                  (msg) => msg.id === assistantMessageId
                );
                if (currentMessage) {
                  const newContents = addContentToMessage(currentMessage.contents, {
                    type: 'toolUse',
                    toolUse,
                  });
                  updateMessage(sessionId, assistantMessageId, {
                    contents: newContents,
                  });
                }
              },
              onToolInputUpdate: (toolUseId: string, input: Record<string, unknown>) => {
                const { activeSessionId, sessions } = get();
                if (activeSessionId !== sessionId) return;

                // Update tool input parameters
                const sessionState = sessions[sessionId];
                if (!sessionState) return;

                const currentMessage = sessionState.messages.find(
                  (msg) => msg.id === assistantMessageId
                );
                if (currentMessage) {
                  const updatedContents = currentMessage.contents.map((content) => {
                    if (content.type === 'toolUse' && content.toolUse) {
                      // Match by originalToolUseId or local ID
                      if (
                        content.toolUse.originalToolUseId === toolUseId ||
                        content.toolUse.id === toolUseId
                      ) {
                        return {
                          ...content,
                          toolUse: {
                            ...content.toolUse,
                            input,
                          },
                        };
                      }
                    }
                    return content;
                  });

                  updateMessage(sessionId, assistantMessageId, {
                    contents: updatedContents,
                  });
                }
              },
              onToolResult: (toolResult: ToolResult) => {
                const { activeSessionId, sessions } = get();
                if (activeSessionId !== sessionId) return;

                // Add tool result
                const sessionState = sessions[sessionId];
                if (!sessionState) return;

                const currentMessage = sessionState.messages.find(
                  (msg) => msg.id === assistantMessageId
                );
                if (currentMessage) {
                  // Update ToolUse status to completed
                  const updatedContentsWithStatus = updateToolUseStatus(
                    currentMessage.contents,
                    toolResult.toolUseId,
                    'completed'
                  );

                  // Add tool result
                  const finalContents = addContentToMessage(updatedContentsWithStatus, {
                    type: 'toolResult',
                    toolResult,
                  });

                  updateMessage(sessionId, assistantMessageId, {
                    contents: finalContents,
                  });
                  // No flag needed: the trailing block is now a toolResult, so the
                  // next text/reasoning delta starts a fresh block automatically
                  // (see appendStreamingDelta).
                }
              },
              onComplete: (metadata) => {
                // Surface the GoalLoop summary (if this turn ran under a goal).
                // `metadata.goalResult` is only present for goal turns; the UI
                // shows a "refined N times" note when attempts > 1.
                const goalResult = (
                  metadata as {
                    goalResult?: { passed: boolean; stopReason: string; attempts: number };
                  }
                )?.goalResult;
                updateMessage(sessionId, assistantMessageId, {
                  isStreaming: false,
                  ...(goalResult ? { goalResult } : {}),
                });

                const { sessions, lastStreamCompletedAt } = get();
                const currentState = sessions[sessionId] || createDefaultSessionState();

                set({
                  sessions: {
                    ...sessions,
                    [sessionId]: {
                      ...currentState,
                      isLoading: false,
                    },
                  },
                  // WHY: Record completion time for the grace-period dedup guard.
                  // See useMessageEventsSubscription for the full explanation of
                  // why this timestamp is needed to prevent duplicate messages.
                  lastStreamCompletedAt: {
                    ...lastStreamCompletedAt,
                    [sessionId]: Date.now(),
                  },
                });

                logger.log(`Message send complete (session: ${sessionId})`);

                // For new sessions, update session list
                if (isNewSession) {
                  logger.log('New session created, updating session list...');
                  useSessionStore.getState().refreshSessions();
                }
              },
              onError: (error: Error) => {
                // Add error message as assistant response (with isError flag)
                const { sessions } = get();
                const sessionState = sessions[sessionId];
                if (!sessionState) return;

                const currentMessage = sessionState.messages.find(
                  (msg) => msg.id === assistantMessageId
                );

                // Preserve existing contents and add error message
                const existingContents = currentMessage?.contents || [];
                const errorContent = {
                  type: 'text' as const,
                  text: `An error occurred: ${error.message}`,
                };

                updateMessage(sessionId, assistantMessageId, {
                  contents: [...existingContents, errorContent],
                  isStreaming: false,
                  isError: true,
                });

                const currentState = sessions[sessionId] || createDefaultSessionState();

                set({
                  sessions: {
                    ...sessions,
                    [sessionId]: {
                      ...currentState,
                      isLoading: false,
                      error: error.message,
                    },
                  },
                });
              },
            },
            agentConfig
          );
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Failed to send message';

          const { sessions } = get();
          const currentState = sessions[sessionId] || createDefaultSessionState();

          set({
            sessions: {
              ...sessions,
              [sessionId]: {
                ...currentState,
                isLoading: false,
                error: errorMessage,
              },
            },
          });
        }
      },

      clearSession: (sessionId: string) => {
        const { sessions } = get();
        const newSessions = { ...sessions };
        delete newSessions[sessionId];

        set({ sessions: newSessions });
        logger.log(`Session cleared: ${sessionId}`);
      },

      setLoading: (sessionId: string, loading: boolean) => {
        const { sessions } = get();
        const sessionState = getOrCreateSessionState(sessions, sessionId);

        set({
          sessions: {
            ...sessions,
            [sessionId]: {
              ...sessionState,
              isLoading: loading,
            },
          },
        });
      },

      setError: (sessionId: string, error: string | null) => {
        const { sessions } = get();
        const sessionState = getOrCreateSessionState(sessions, sessionId);

        set({
          sessions: {
            ...sessions,
            [sessionId]: {
              ...sessionState,
              error,
            },
          },
        });
      },

      clearError: (sessionId: string) => {
        const { sessions } = get();
        const sessionState = getOrCreateSessionState(sessions, sessionId);

        set({
          sessions: {
            ...sessions,
            [sessionId]: {
              ...sessionState,
              error: null,
            },
          },
        });
      },

      loadSessionHistory: (sessionId: string, conversationMessages: ConversationMessage[]) => {
        logger.log(
          `Restoring conversation history (${sessionId}): ${conversationMessages.length} messages`
        );

        // Helper function to check if message contains error marker
        const isErrorMessage = (contents: MessageContent[]): boolean => {
          return contents.some(
            (content) =>
              content.type === 'text' &&
              content.text &&
              (content.text.includes('[SYSTEM_ERROR]') ||
                content.text.startsWith('An error occurred:') ||
                content.text.startsWith('エラーが発生しました:'))
          );
        };

        // Helper function to convert API MessageContent to local MessageContent type
        const convertContents = (
          apiContents: ConversationMessage['contents']
        ): MessageContent[] => {
          return apiContents.map((content) => {
            if (content.type === 'image' && content.image) {
              // Convert API image format to ImageAttachment format
              return {
                type: 'image' as const,
                image: {
                  id: randomId(),
                  fileName: content.image.fileName || 'image',
                  mimeType: content.image.mimeType,
                  size: 0, // Size not available from API
                  base64: content.image.base64,
                } as ImageAttachment,
              };
            }
            // Other types are compatible
            return content as MessageContent;
          });
        };

        // Convert ConversationMessage to Message type
        const messages: Message[] = conversationMessages.map((convMsg) => {
          const contents = convertContents(convMsg.contents);
          return {
            id: convMsg.id,
            type: convMsg.type,
            contents,
            timestamp: new Date(convMsg.timestamp),
            isStreaming: false, // History data is not streaming
            isError: convMsg.type === 'assistant' && isErrorMessage(contents), // Detect error message
          };
        });

        const { sessions } = get();
        set({
          sessions: {
            ...sessions,
            [sessionId]: {
              messages,
              isLoading: false,
              error: null,
              lastUpdated: new Date(),
            },
          },
        });

        logger.log(`Conversation history restored (${sessionId}): ${messages.length} messages`);
      },
    }),
    {
      name: 'chat-store',
      enabled: import.meta.env.DEV,
    }
  )
);
