/**
 * react-markdown component overrides shared by chat messages and the storage
 * Markdown preview: storage-path links/images resolve through presigned URLs,
 * fenced code is highlighted, ```mermaid renders a diagram.
 */

import React from 'react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { MermaidDiagram } from '../MermaidDiagram';
import { S3FileLink } from '../S3FileLink';
import { S3Image } from '../S3Image';
import { S3Video } from '../S3Video';

/** Absolute user-storage path (not protocol-relative, not the same-origin API). */
export const isStoragePath = (href: string): boolean =>
  href.startsWith('/') && !href.startsWith('//') && !href.startsWith('/api/');

/**
 * Resolves Markdown links/images against the file's folder so `![](./a.png)`
 * loads from storage. URLs with a scheme, protocol-relative URLs and
 * fragments stay regular links.
 */
/** decodeURI throws on malformed escapes (`a%zz.png`); keep such paths as written. */
function safeDecodeURI(value: string): string {
  try {
    return decodeURI(value);
  } catch {
    return value;
  }
}

export function resolveStorageHref(href: string, baseDir: string): string | null {
  if (isStoragePath(href)) return href;
  if (/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith('/') || href.startsWith('#')) {
    return null;
  }
  const clean = href.split(/[?#]/)[0];
  if (!clean) return null;
  const segments = baseDir.split('/').filter(Boolean);
  for (const part of safeDecodeURI(clean).split('/')) {
    if (part === '..') segments.pop();
    else if (part && part !== '.') segments.push(part);
  }
  return `/${segments.join('/')}`;
}

const isVideoFile = (path: string): boolean => {
  const videoExtensions = ['.mp4', '.webm', '.mov', '.avi', '.mkv', '.m4v'];
  const lowerPath = path.toLowerCase();
  return videoExtensions.some((ext) => lowerPath.endsWith(ext));
};

export interface MarkdownComponentsOptions {
  isDark: boolean;
  /**
   * Maps an href/src to a storage path, or null for a regular URL.
   * Defaults to accepting absolute storage paths only.
   */
  toStoragePath?: (href: string) => string | null;
}

const defaultToStoragePath = (href: string) => (isStoragePath(href) ? href : null);

export function createMarkdownComponents({
  isDark,
  toStoragePath = defaultToStoragePath,
}: MarkdownComponentsOptions) {
  return {
    // Custom link renderer for S3 files
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    a: ({ href, children, ...props }: any) => {
      const storagePath = href ? toStoragePath(href) : null;
      if (storagePath) {
        // Check if it's a video file and display inline
        if (isVideoFile(storagePath)) {
          return (
            <div className="my-4">
              <S3Video path={storagePath} className="max-w-full" />
            </div>
          );
        }
        return <S3FileLink path={storagePath}>{children}</S3FileLink>;
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
      const storagePath = src ? toStoragePath(src) : null;
      if (storagePath) {
        // Check if it's a video file and display inline
        if (isVideoFile(storagePath)) {
          return (
            <div className="my-4">
              <S3Video path={storagePath} className="max-w-full" />
            </div>
          );
        }
        return <S3Image path={storagePath} alt={alt || ''} className="max-w-full rounded-lg" />;
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
          className="bg-surface-secondary text-fg-default px-1 py-0.5 rounded-sm text-sm"
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
        className="border border-border-strong px-4 py-2 bg-surface-secondary font-semibold text-left wrap-break-word"
        {...props}
      >
        {children}
      </th>
    ),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    td: ({ children, ...props }: any) => (
      <td className="border border-border-strong px-4 py-2 wrap-break-word" {...props}>
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
  };
}
