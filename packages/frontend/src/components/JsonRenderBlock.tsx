import React from 'react';
import { Renderer, JSONUIProvider } from '@json-render/react';
import type { Spec } from '@json-render/core';
import { registry } from './generative-ui-catalog';
import { extractUISpec } from '../utils/generative-ui';

interface JsonRenderBlockProps {
  content: string;
}

export const JsonRenderBlock: React.FC<JsonRenderBlockProps> = ({ content }) => {
  const spec = React.useMemo<Spec | null>(() => extractUISpec(content) as Spec | null, [content]);

  if (!spec) {
    return (
      <pre className="text-xs bg-surface-secondary rounded p-3 overflow-x-auto whitespace-pre-wrap break-words">
        {content}
      </pre>
    );
  }

  return (
    <div className="generative-ui-render p-3">
      <JSONUIProvider registry={registry} initialState={spec.state}>
        <Renderer spec={spec} registry={registry} />
      </JSONUIProvider>
    </div>
  );
};
