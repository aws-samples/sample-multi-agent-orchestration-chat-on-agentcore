import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { cn } from '../../lib/utils';

/** Agent output rendered as Markdown (raw HTML is not enabled, so it stays text). */
export const WorkflowMarkdown: React.FC<{ text: string; className?: string }> = ({
  text,
  className,
}) => (
  <div className={cn('markdown-content prose prose-sm max-w-none text-fg-default', className)}>
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{text}</ReactMarkdown>
  </div>
);
