import React from 'react';
import { Renderer, JSONUIProvider } from '@json-render/react';
import type { Spec } from '@json-render/core';
import { registry } from './generative-ui-catalog';
import { extractUISpec } from '../utils/generative-ui';
import { GenerativeUiInteractionContext } from './generative-ui-catalog/interaction-context';

interface JsonRenderBlockProps {
  content: string;
  /** Whether interactive components (e.g. SuggestedReplies) may send messages. */
  interactive?: boolean;
}

export const JsonRenderBlock: React.FC<JsonRenderBlockProps> = ({
  content,
  interactive = false,
}) => {
  const interaction = React.useMemo(() => ({ interactive }), [interactive]);
  const spec = React.useMemo<Spec | null>(() => extractUISpec(content) as Spec | null, [content]);

  if (!spec) {
    return (
      <pre className="text-xs bg-surface-secondary rounded-sm p-3 overflow-x-auto whitespace-pre-wrap wrap-break-word">
        {content}
      </pre>
    );
  }

  return (
    <div className="generative-ui-render p-3">
      <GenerativeUiInteractionContext.Provider value={interaction}>
        <JSONUIProvider registry={registry} initialState={spec.state}>
          <Renderer spec={spec} registry={registry} />
        </JSONUIProvider>
      </GenerativeUiInteractionContext.Provider>
    </div>
  );
};
