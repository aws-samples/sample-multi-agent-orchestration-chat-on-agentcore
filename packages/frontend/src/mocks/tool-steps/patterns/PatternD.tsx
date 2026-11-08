import React from 'react';
import type { StepGroupViewProps } from '../types';

// TODO: implemented by the pattern-D worker.
export const PatternD: React.FC<StepGroupViewProps> = ({ group }) => (
  <div className="text-xs text-fg-muted">Pattern D: {group.steps.length} steps (not implemented)</div>
);
