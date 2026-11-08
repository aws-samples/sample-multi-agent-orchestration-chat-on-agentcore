import React, { useMemo } from 'react';
import type { MessageContent } from '../../../types/index';
import { ToolStepsGroup } from '../../../components/ToolStepsGroup';
import { buildSegments } from '../../../utils/tool-steps';
import type { Step, StepGroupViewProps } from '../types';

/** Feeds the mock group through the production pipeline (MessageContent → buildSegments → ToolStepsGroup). */
const toContents = (steps: Step[]): MessageContent[] =>
  steps.flatMap((s): MessageContent[] => {
    if (s.kind === 'reasoning') return [{ type: 'reasoning', reasoning: { text: s.text } }];
    const use: MessageContent = {
      type: 'toolUse',
      toolUse: { id: s.id, name: s.name, input: s.input, status: s.status === 'running' ? 'running' : 'completed' },
    };
    if (s.result === undefined) return [use];
    return [use, { type: 'toolResult', toolResult: { toolUseId: s.id, content: s.result, isError: s.status === 'error' } }];
  });

export const ImplPattern: React.FC<StepGroupViewProps> = ({ group, isLive }) => {
  const segments = useMemo(() => buildSegments(toContents(group.steps), isLive), [group.steps, isLive]);
  return (
    <>
      {segments.map((seg) =>
        seg.type === 'steps' ? <ToolStepsGroup key={seg.key} steps={seg.steps} isLive={isLive} /> : null
      )}
    </>
  );
};
