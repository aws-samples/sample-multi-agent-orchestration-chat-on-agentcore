import React from 'react';
import type { StepGroupViewProps } from '../types';

// TODO: implemented by the pattern-A worker.
export const PatternA: React.FC<StepGroupViewProps> = ({ group }) => (
  <div className="text-xs text-fg-muted">Pattern A: {group.steps.length} steps (not implemented)</div>
);
