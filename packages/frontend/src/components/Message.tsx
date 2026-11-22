import React, { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { useTranslation } from 'react-i18next';
import { AlertTriangle } from 'lucide-react';
import type { Message as MessageType } from '../types/index';
import { useThemeStore } from '../stores/themeStore';
import { useUIStore } from '../stores/uiStore';
import { useFilePreviewStore } from '../stores/filePreviewStore';
import { TypingIndicator } from './TypingIndicator';
import { ToolStepsGroup } from './ToolStepsGroup';
import { JsonRenderBlock } from './JsonRenderBlock';
import { buildSegments } from '../utils/tool-steps';
import { formatBytes } from '../utils/formatBytes';
import { parseWorkflowNotification } from '../utils/session-workflows';
import { WorkflowNotice } from './workflow/WorkflowNotice';
import { createMarkdownComponents } from './markdown/markdownComponents';
import { TokenLimitRetryButton } from './TokenLimitRetryButton';

interface MessageProps {
  message: MessageType;
  /** Latest message of an idle session — enables generative UI reply choices. */
  isInteractive?: boolean;
}

export const Message: React.FC<MessageProps> = ({ message, isInteractive = false }) => {
  const { t } = useTranslation();
  const resolvedTheme = useThemeStore((s) => s.resolvedTheme);
  const isDark = resolvedTheme === 'dark';
  const isWideView = useUIStore((s) => s.isWideView);
  const isUser = message.type === 'user';
  const segments = useMemo(
    () => buildSegments(message.contents, Boolean(message.isStreaming)),
    [message.contents, message.isStreaming]
  );
  const lastSegment = segments[segments.length - 1];

  // Full-width block content (tool cards, reasoning panel) lays the message out
  // edge-to-edge instead of in a content-hugging bubble. Reasoning is included so
  // that a turn streaming reasoning first — before any answer text — is already
  // full width and doesn't visibly jump wider once the text arrives.
  const hasBlockContent = message.contents.some(
    (content) =>
      content.type === 'toolUse' || content.type === 'toolResult' || content.type === 'reasoning'
  );

  // Stable reference so ReactMarkdown does not remount custom renderers.
  const openFilePreview = useFilePreviewStore((s) => s.open);
  const markdownComponents = useMemo(
    () => createMarkdownComponents({ isDark, onOpenFile: openFilePreview }),
    [isDark, openFilePreview]
  );

  const workflowNotice = useMemo(() => parseWorkflowNotification(message), [message]);
  if (workflowNotice) return <WorkflowNotice notice={workflowNotice} />;

  return (
    <div
      className={`flex ${hasBlockContent ? 'mb-2' : 'mb-6'} ${hasBlockContent ? 'justify-start' : isUser ? 'justify-end' : 'justify-start'}`}
    >
      <div
        className={`flex flex-row items-start w-full transition-[max-width] duration-300 ease-in-out ${
          hasBlockContent
            ? 'max-w-full'
            : isWideView
              ? isUser
                ? 'max-w-full ml-auto'
                : 'max-w-full'
              : isUser
                ? 'max-w-3xl ml-auto'
                : 'max-w-4xl'
        }`}
      >
        {/* Message bubble */}
        <div
          className={`relative ${
            hasBlockContent
              ? 'w-full'
              : isUser
                ? 'message-bubble message-user'
                : 'message-bubble message-assistant'
          }`}
        >
          {/* Error icon display */}
          {message.isError && (
            <div className="flex items-center gap-2 mb-2 text-feedback-error">
              <AlertTriangle className="w-5 h-5" />
              <span className="text-sm font-medium">
                {message.errorTitle ?? t('common.errorOccurred')}
              </span>
            </div>
          )}

          {/* Message content */}
          <div className="prose prose-sm max-w-none">
            <div className="message-contents space-y-2">
              {segments.map((segment, index) => {
                switch (segment.type) {
                  case 'text':
                    return (
                      <div key={segment.key} className="markdown-content">
                        <ReactMarkdown
                          remarkPlugins={[remarkGfm, remarkBreaks, remarkMath]}
                          rehypePlugins={[rehypeKatex]}
                          components={markdownComponents}
                        >
                          {segment.text}
                        </ReactMarkdown>
                      </div>
                    );

                  case 'steps':
                    return (
                      <ToolStepsGroup
                        key={segment.key}
                        steps={segment.steps}
                        // Live only while the agent is still working inside this
                        // group; once text/UI follows it folds automatically.
                        isLive={Boolean(message.isStreaming) && index === segments.length - 1}
                      />
                    );

                  case 'ui':
                    return (
                      <JsonRenderBlock
                        key={segment.key}
                        content={segment.content}
                        interactive={isInteractive}
                      />
                    );

                  case 'truncated':
                    return (
                      <div key={segment.key} className="text-xs text-fg-muted italic py-0.5">
                        {t('chat.contentOmitted', {
                          size: formatBytes(segment.byteSize),
                        })}
                      </div>
                    );

                  case 'image': {
                    const image = segment.image;
                    // Use previewUrl if available (newly attached), otherwise construct from base64 (from session history)
                    const imageSrc =
                      image.previewUrl ||
                      (image.base64
                        ? // eslint-disable-next-line i18next/no-literal-string -- data URL, not UI text
                          `data:${image.mimeType};base64,${image.base64}`
                        : '');
                    return imageSrc ? (
                      <div key={segment.key} className="inline-block mr-2 mb-2">
                        <img
                          src={imageSrc}
                          alt={image.fileName || t('chat.imageAttachment.alt')}
                          className="max-w-xs max-h-48 object-contain rounded-lg border border-border"
                        />
                      </div>
                    ) : null;
                  }

                  default:
                    return (
                      <div key={segment.key} className="text-fg-muted text-sm">
                        {t('common.unsupportedContentType', { type: segment.contentType })}
                      </div>
                    );
                }
              })}

              {/* Show TypingIndicator while streaming, waiting for the next content */}
              {/* A live multi-step group has a spinner in its header; a lone step does not. */}
              {message.isStreaming &&
                (segments.length === 0 ||
                  (message.contents[message.contents.length - 1]?.type === 'toolResult' &&
                    !(lastSegment?.type === 'steps' && lastSegment.steps.length > 1))) && (
                  <TypingIndicator />
                )}
            </div>
          </div>

          {message.notice && (
            <p className="mt-2 pt-2 border-t border-border text-xs text-fg-muted">
              {message.notice}
            </p>
          )}
          {message.tokenLimitRetry && <TokenLimitRetryButton retry={message.tokenLimitRetry} />}
        </div>
      </div>
    </div>
  );
};
