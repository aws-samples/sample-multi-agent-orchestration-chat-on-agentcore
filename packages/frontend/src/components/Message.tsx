import React, { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { useTranslation } from 'react-i18next';
import { AlertTriangle } from 'lucide-react';
import type { Message as MessageType } from '../types/index';
import { useThemeStore } from '../stores/themeStore';
import { TypingIndicator } from './TypingIndicator';
import { ToolUseBlock } from './ToolUseBlock';
import { ToolResultBlock } from './ToolResultBlock';
import { JsonRenderBlock } from './JsonRenderBlock';
import { extractUISpec } from '../utils/generative-ui';
import { MermaidDiagram } from './MermaidDiagram';
import { S3FileLink } from './S3FileLink';
import { S3Image } from './S3Image';
import { S3Video } from './S3Video';

interface MessageProps {
  message: MessageType;
}

export const Message: React.FC<MessageProps> = ({ message }) => {
  const { t } = useTranslation();
  const resolvedTheme = useThemeStore((s) => s.resolvedTheme);
  const isDark = resolvedTheme === 'dark';
  const isUser = message.type === 'user';

  // Check if message contains toolUse/toolResult
  const hasToolContent = message.contents.some(
    (content) => content.type === 'toolUse' || content.type === 'toolResult'
  );

  // Check if a path is an S3 storage path (user relative path)
  const isStoragePath = (href: string): boolean => {
    return href.startsWith('/') && !href.startsWith('//') && !href.startsWith('/api/');
  };

  // Check if a path is a video file
  const isVideoFile = (path: string): boolean => {
    const videoExtensions = ['.mp4', '.webm', '.mov', '.avi', '.mkv', '.m4v'];
    const lowerPath = path.toLowerCase();
    return videoExtensions.some((ext) => lowerPath.endsWith(ext));
  };

  // Markdown custom component (stabilize reference with memoization)
  const markdownComponents = useMemo(
    () => ({
      // Custom link renderer for S3 files
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      a: ({ href, children, ...props }: any) => {
        if (href && isStoragePath(href)) {
          // Check if it's a video file and display inline
          if (isVideoFile(href)) {
            return (
              <div className="my-4">
                <S3Video path={href} className="max-w-full" />
              </div>
            );
          }
          return <S3FileLink path={href}>{children}</S3FileLink>;
        }
        // Regular link
        return (
          <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
            {children}
          </a>
        );
      },
      // Custom image renderer for S3 images and videos
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      img: ({ src, alt, ...props }: any) => {
        if (src && isStoragePath(src)) {
          // Check if it's a video file and display inline
          if (isVideoFile(src)) {
            return (
              <div className="my-4">
                <S3Video path={src} className="max-w-full" />
              </div>
            );
          }
          return <S3Image path={src} alt={alt || ''} className="max-w-full rounded-lg" />;
        }
        // Regular image
        return <img src={src} alt={alt} {...props} />;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      code: ({ className, children, ...props }: any) => {
        const match = /language-(\w+)/.exec(className || '');
        const language = match ? match[1] : '';

        // Check if this is a code block (not inline)
        // Since react-markdown v9+ may not provide `inline` reliably,
        // we check if content has newlines or has a language class
        const codeString = String(children);
        const hasNewline = codeString.includes('\n');
        const isCodeBlock = hasNewline || Boolean(className);

        if (isCodeBlock && match) {
          // For Mermaid diagram
          if (language === 'mermaid') {
            return <MermaidDiagram chart={String(children).replace(/\n$/, '')} />;
          }

          // Code blocks with language specification
          return (
            <SyntaxHighlighter
              style={isDark ? oneDark : oneLight}
              language={language}
              PreTag="div"
              className="rounded-lg text-sm"
              {...props}
            >
              {String(children).replace(/\n$/, '')}
            </SyntaxHighlighter>
          );
        }

        if (isCodeBlock && !match) {
          // Code blocks without language specification
          return (
            <code
              className="block whitespace-pre-wrap bg-surface-secondary text-fg-default p-4 rounded-lg text-sm overflow-x-auto font-mono"
              {...props}
            >
              {children}
            </code>
          );
        }

        // Inline code
        return (
          <code
            className="bg-surface-secondary text-fg-default px-1 py-0.5 rounded text-sm"
            {...props}
          >
            {children}
          </code>
        );
      },
      // Adjust table style
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      table: ({ children, ...props }: any) => (
        <div className="overflow-x-auto my-4">
          <table className="min-w-full border-collapse border border-border-strong" {...props}>
            {children}
          </table>
        </div>
      ),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      th: ({ children, ...props }: any) => (
        <th
          className="border border-border-strong px-4 py-2 bg-surface-secondary font-semibold text-left"
          {...props}
        >
          {children}
        </th>
      ),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      td: ({ children, ...props }: any) => (
        <td className="border border-border-strong px-4 py-2" {...props}>
          {children}
        </td>
      ),
      // Quote style
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      blockquote: ({ children, ...props }: any) => (
        <blockquote
          className="border-l-4 border-border-strong pl-4 py-2 my-4 bg-surface-secondary italic"
          {...props}
        >
          {children}
        </blockquote>
      ),
      // Paragraph: Use div if contains block elements (like video)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      p: ({ children, ...props }: any) => {
        // Check if any child contains a div (which happens when S3Video is rendered)
        const childArray = React.Children.toArray(children);
        const hasBlockElement = childArray.some((child) => {
          if (React.isValidElement(child)) {
            // Check if the element has a div in its structure
            const elementType = child.type;
            // S3Video and S3Image components return div elements
            if (typeof elementType === 'function') {
              // This is a component, we assume it might contain block elements
              return true;
            }
          }
          return false;
        });

        // If there's a block element, use div instead of p to avoid nesting errors
        if (hasBlockElement) {
          return <div {...props}>{children}</div>;
        }

        return <p {...props}>{children}</p>;
      },
    }),
    [isDark]
  );

  return (
    <div
      className={`flex ${hasToolContent ? 'mb-2' : 'mb-6'} ${hasToolContent ? 'justify-start' : isUser ? 'justify-end' : 'justify-start'}`}
    >
      <div
        className={`flex flex-row items-start w-full ${
          hasToolContent ? 'max-w-full' : isUser ? 'max-w-3xl ml-auto' : 'max-w-4xl'
        }`}
      >
        {/* Message bubble */}
        <div
          className={`relative ${
            hasToolContent
              ? 'w-full'
              : isUser
                ? 'message-bubble message-user'
                : 'message-bubble message-assistant'
          } ${message.isStreaming ? 'bg-opacity-90' : ''}`}
        >
          {/* Error icon display */}
          {message.isError && (
            <div className="flex items-center gap-2 mb-2 text-feedback-error">
              <AlertTriangle className="w-5 h-5" />
              <span className="text-sm font-medium">{t('common.errorOccurred')}</span>
            </div>
          )}

          {/* Message content */}
          <div className="prose prose-sm max-w-none">
            <div className="message-contents space-y-2">
              {message.contents.map((content, index) => {
                switch (content.type) {
                  case 'text':
                    return (
                      <div key={`text-${index}`} className="markdown-content">
                        <ReactMarkdown
                          remarkPlugins={[remarkGfm, remarkMath]}
                          rehypePlugins={[rehypeKatex]}
                          components={markdownComponents}
                        >
                          {content.text || ''}
                        </ReactMarkdown>
                      </div>
                    );

                  case 'toolUse':
                    return content.toolUse ? (
                      <ToolUseBlock key={`tool-use-${index}`} toolUse={content.toolUse} />
                    ) : null;

                  case 'toolResult': {
                    if (!content.toolResult) return null;
                    if (extractUISpec(content.toolResult.content) !== null) {
                      return (
                        <JsonRenderBlock
                          key={`json-render-${index}`}
                          content={content.toolResult.content}
                        />
                      );
                    }
                    return (
                      <ToolResultBlock
                        key={`tool-result-${index}`}
                        toolResult={content.toolResult}
                      />
                    );
                  }

                  case 'image': {
                    if (!content.image) return null;
                    // Use previewUrl if available (newly attached), otherwise construct from base64 (from session history)
                    const imageSrc =
                      content.image.previewUrl ||
                      (content.image.base64
                        ? `data:${content.image.mimeType};base64,${content.image.base64}`
                        : '');
                    return imageSrc ? (
                      <div key={`image-${index}`} className="inline-block mr-2 mb-2">
                        <img
                          src={imageSrc}
                          alt={content.image.fileName || 'Attached image'}
                          className="max-w-xs max-h-48 object-contain rounded-lg border border-border"
                        />
                      </div>
                    ) : null;
                  }

                  default:
                    return (
                      <div key={`unknown-${index}`} className="text-fg-muted text-sm">
                        {t('common.unsupportedContentType', { type: content.type })}
                      </div>
                    );
                }
              })}

              {/* Show TypingIndicator while streaming, waiting for the next content */}
              {message.isStreaming &&
                (message.contents.length === 0 ||
                  message.contents[message.contents.length - 1]?.type === 'toolResult') && (
                  <TypingIndicator />
                )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
