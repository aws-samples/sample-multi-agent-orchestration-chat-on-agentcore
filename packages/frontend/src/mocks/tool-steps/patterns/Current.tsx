import React from 'react';
import { ToolUseBlock } from '../../../components/ToolUseBlock';
import { ToolResultBlock } from '../../../components/ToolResultBlock';
import { ReasoningBlock } from '../../../components/ReasoningBlock';
import type { Step, StepGroupViewProps } from '../types';

/** Baseline: what Message.tsx renders today — one block per content item, never grouped. */
const renderStep = (step: Step, isLive: boolean): React.ReactNode[] => {
  if (step.kind === 'reasoning') {
    return [
      <ReasoningBlock
        key={step.id}
        reasoning={{ text: step.text }}
        isStreaming={isLive && step.status === 'running'}
      />,
    ];
  }
  const nodes: React.ReactNode[] = [
    <ToolUseBlock
      key={step.id}
      toolUse={{ id: step.id, name: step.name, input: step.input, status: step.status }}
    />,
  ];
  if (step.result !== undefined) {
    nodes.push(
      <ToolResultBlock
        key={`${step.id}-r`}
        toolResult={{ toolUseId: step.id, content: step.result, isError: step.status === 'error' }}
      />
    );
  }
  return nodes;
};

export const CurrentPattern: React.FC<StepGroupViewProps> = ({ group, isLive }) => (
  <div className="space-y-2">{group.steps.flatMap((s) => renderStep(s, isLive))}</div>
);
