import React from 'react';
import type { StepGroupViewProps } from '../types';

// TODO: implemented by the pattern-B worker.
export const PatternB: React.FC<StepGroupViewProps> = ({ group }) => (
  <div className="text-xs text-fg-muted">Pattern B: {group.steps.length} steps (not implemented)</div>
);
