import type { UserId } from '@moca/core';

// User types
export interface User {
  /**
   * Cognito `sub` claim (UUID), branded via `@moca/core`'s {@link UserId} so
   * it cannot be silently confused with other UUID-shaped identifiers such as
   * `AgentId` or `TriggerId`. Obtained from {@link extractUserIdFromAccessToken}.
   */
  userId: UserId;
  username: string;
  email?: string;
}

// Tool Use types
export interface ToolUse {
  id: string;
  name: string;
  input: Record<string, unknown>;
  status?: 'pending' | 'running' | 'completed' | 'error';
  originalToolUseId?: string;
}

// Tool Result types
export interface ToolResult {
  toolUseId: string;
  content: string;
  isError?: boolean;
}

// Image Attachment types
export interface ImageAttachment {
  id: string;
  file?: File;
  fileName: string;
  mimeType: string;
  size: number;
  previewUrl?: string;
  base64?: string;
}

// Image attachment configuration constants
export const IMAGE_ATTACHMENT_CONFIG = {
  MAX_FILE_SIZE: 5 * 1024 * 1024, // 5MB per file
  MAX_TOTAL_SIZE: 7 * 1024 * 1024, // 7MB total (Base64 encoded ~9.3MB, within AgentCore Memory 10MB limit)
  MAX_COUNT: 4,
  ACCEPTED_TYPES: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const,
  ACCEPTED_EXTENSIONS: ['.png', '.jpg', '.jpeg', '.webp', '.gif'] as const,
} as const;

export type AcceptedImageType = (typeof IMAGE_ATTACHMENT_CONFIG.ACCEPTED_TYPES)[number];

// Reasoning (extended thinking) types. Only the human-readable `text` is ever
// shown; the cryptographic signature / redactedContent are round-trip-only and
// never reach the frontend.
export interface Reasoning {
  text: string;
}

// Message Content types
export interface MessageContent {
  type: 'text' | 'toolUse' | 'toolResult' | 'image' | 'reasoning';
  text?: string;
  toolUse?: ToolUse;
  toolResult?: ToolResult;
  image?: ImageAttachment;
  reasoning?: Reasoning;
}

// Message types
export interface Message {
  id: string;
  type: 'user' | 'assistant';
  contents: MessageContent[]; // Changed from single content string to multiple content blocks
  timestamp: Date;
  isStreaming?: boolean;
  isError?: boolean; // Flag to indicate this message contains an error
}

// Session-specific chat state
export interface SessionChatState {
  messages: Message[];
  isLoading: boolean;
  error: string | null;
  lastUpdated: Date;
}

// Chat types
export interface ChatState {
  sessions: Record<string, SessionChatState>;
  activeSessionId: string | null;
  /**
   * WHY: Tracks when HTTP streaming completed per session (epoch ms).
   *
   * Used by useMessageEventsSubscription to ignore late-arriving AppSync
   * events in the sender tab during a grace period after streaming ends.
   * This is tab-local (Zustand state is not shared across browser tabs),
   * so it only suppresses duplicates in the tab that sent the message —
   * other tabs still receive AppSync events normally for cross-tab sync.
   *
   * See useMessageEventsSubscription hook JSDoc for the full deduplication
   * strategy explanation.
   */
  lastStreamCompletedAt: Record<string, number>;
}

// Auth types
export interface AuthState {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  /**
   * Whether the initial bootstrap read of Amplify's session has completed.
   *
   * WHY separate from `isLoading`: `isLoading` is re-used by interactive
   * flows (login submit, signup, etc.). Routing decisions on page load must
   * only gate on "have we finished the first `fetchAuthSession()` read?",
   * not on transient spinner state. Without this flag the auth UI renders
   * for one frame on reload and its catch-all `<Navigate to="/login" />`
   * rewrites the URL, losing the user's deep-linked path.
   */
  isBootstrapped: boolean;
  error: string | null;
  needsConfirmation: boolean;
  pendingUsername: string | null;
  needsNewPassword: boolean;
}

// API types
export interface AgentStreamEvent {
  type: string;
  [key: string]: unknown;
}

export interface ModelContentBlockDeltaEvent extends AgentStreamEvent {
  type: 'modelContentBlockDeltaEvent';
  delta:
    | {
        type: 'textDelta';
        text: string;
      }
    | {
        // Reasoning (extended thinking) delta. `text` carries the human-readable
        // reasoning; `signature` / `redactedContentBase64` are round-trip-only
        // and intentionally not consumed by the UI.
        type: 'reasoningContentDelta';
        text?: string;
        signature?: string;
        redactedContentBase64?: string;
      };
}

export interface ModelContentBlockStartEvent extends AgentStreamEvent {
  type: 'modelContentBlockStartEvent';
  start?: {
    type: string;
    name?: string;
    input?: Record<string, unknown>;
    toolUseId?: string;
  };
}

export interface MessageAddedEvent extends AgentStreamEvent {
  type: 'messageAddedEvent';
  message?: {
    role?: string;
    content?: Array<{
      type: string;
      toolUseId?: string;
      content?: string;
      isError?: boolean;
      [key: string]: unknown;
    }>;
  };
}

export interface BeforeToolsEvent extends AgentStreamEvent {
  type: 'beforeToolsEvent';
  message?: {
    role: string;
    content: Array<{
      type: string;
      name?: string;
      input?: Record<string, unknown>;
      toolUseId?: string;
      text?: string; // For textBlock
      [key: string]: unknown;
    }>;
  };
}

export interface AfterToolsEvent extends AgentStreamEvent {
  type: 'afterToolsEvent';
  [key: string]: unknown;
}

export interface ServerCompletionEvent extends AgentStreamEvent {
  type: 'serverCompletionEvent';
  metadata: {
    requestId: string;
    duration: number;
    sessionId: string;
    conversationLength: number;
    /**
     * Present only when the turn ran under a GoalLoop (a goal was sent).
     * `attempts` is the number of refinement attempts (1 = passed first try).
     * Per-attempt feedback text is intentionally NOT streamed to the client.
     */
    goalResult?: { passed: boolean; stopReason: string; attempts: number };
  };
}

export interface ServerErrorEvent extends AgentStreamEvent {
  type: 'serverErrorEvent';
  error: {
    message: string;
    requestId: string;
    savedToHistory?: boolean; // Indicates if error was saved to session history
  };
}

// Config types
export interface AgentConfig {
  endpoint: string;
  cognitoConfig: {
    userPoolId: string;
    clientId: string;
    region: string;
  };
}
