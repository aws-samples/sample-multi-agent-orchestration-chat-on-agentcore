import { z } from 'zod';
import i18n from '../i18n';

// Message schema factory
export const createMessageSchema = () =>
  z.object({
    id: z.string().min(1, i18n.t('validation.chat.messageIdRequired')),
    type: z.enum(['user', 'assistant']),
    content: z.string().min(1, i18n.t('validation.chat.messageContentRequired')),
    timestamp: z.date(),
    isStreaming: z.boolean().optional(),
  });

export type MessageData = z.infer<ReturnType<typeof createMessageSchema>>;

// Chat prompt schema factory
export const createChatPromptSchema = () =>
  z.object({
    prompt: z
      .string()
      .min(1, i18n.t('validation.chat.promptRequired'))
      .max(10000, i18n.t('validation.chat.promptMaxLength'))
      .trim(),
  });

export type ChatPromptData = z.infer<ReturnType<typeof createChatPromptSchema>>;

// Agent config schema factory
export const createAgentConfigSchema = () =>
  z.object({
    endpoint: z.string().url(i18n.t('validation.chat.endpointUrlRequired')),
    cognitoConfig: z.object({
      userPoolId: z.string().min(1, i18n.t('validation.auth.userPoolIdRequired')),
      clientId: z.string().min(1, i18n.t('validation.auth.clientIdRequired')),
      region: z.string().min(1, i18n.t('validation.auth.regionRequired')),
    }),
  });

export type AgentConfigData = z.infer<ReturnType<typeof createAgentConfigSchema>>;

// Stream event schemas
export const agentStreamEventSchema = z
  .object({
    type: z.string(),
  })
  .passthrough(); // Allow additional properties

export const modelContentBlockDeltaEventSchema = z
  .object({
    type: z.literal('modelContentBlockDeltaEvent'),
    delta: z.object({
      type: z.literal('textDelta'),
      text: z.string(),
    }),
  })
  .passthrough();

export const serverCompletionEventSchema = z
  .object({
    type: z.literal('serverCompletionEvent'),
    metadata: z.object({
      requestId: z.string(),
      duration: z.number(),
      sessionId: z.string(),
      conversationLength: z.number(),
    }),
  })
  .passthrough();

export const serverErrorEventSchema = z
  .object({
    type: z.literal('serverErrorEvent'),
    error: z.object({
      message: z.string(),
      requestId: z.string(),
    }),
  })
  .passthrough();

export type AgentStreamEventData = z.infer<typeof agentStreamEventSchema>;
export type ModelContentBlockDeltaEventData = z.infer<typeof modelContentBlockDeltaEventSchema>;
export type ServerCompletionEventData = z.infer<typeof serverCompletionEventSchema>;
export type ServerErrorEventData = z.infer<typeof serverErrorEventSchema>;
