// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import React from 'react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${JSON.stringify(opts)}` : key,
  }),
}));
vi.mock('../../stores/agentStore', () => ({
  useAgentStore: (sel: (s: { agents: unknown[] }) => unknown) =>
    sel({ agents: [{ agentId: 'agent-writer', name: 'Writer' }] }),
}));

const { WorkflowGraph } = await import('../WorkflowGraph');

const spec = {
  goal: 'Compare clouds',
  steps: [
    { id: 'research', agentId: 'agent-writer', prompt: 'Research <b>things</b>' },
    {
      id: 'report',
      agentId: 'unknown-agent-id',
      prompt: 'Write the report',
      dependsOn: ['research'],
      review: { agentId: 'agent-writer', criteria: 'Cite sources', maxIterations: 3 },
    },
  ],
};

describe('WorkflowGraph', () => {
  it('renders one node per step with agent names and a review badge', () => {
    render(<WorkflowGraph spec={spec} />);
    expect(screen.getByRole('button', { name: /research/ })).toHaveTextContent('Writer');
    // Unknown agents fall back to a shortened id.
    expect(screen.getByRole('button', { name: /report/ })).toHaveTextContent('unknown-…');
    expect(screen.getByText('tool.workflowGraph.rounds:{"count":3}')).toBeInTheDocument();
    expect(document.querySelectorAll('svg path[marker-end]')).toHaveLength(1);
  });

  it('shows the selected step prompt as text, never as HTML', () => {
    render(<WorkflowGraph spec={spec} />);
    fireEvent.click(screen.getByRole('button', { name: /research/ }));
    expect(screen.getByText('Research <b>things</b>')).toBeInTheDocument();
    expect(document.querySelector('b')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /report/ }));
    expect(screen.getByText('Cite sources')).toBeInTheDocument();
  });

  it('renders nothing for an unrenderable spec', () => {
    const { container } = render(
      <WorkflowGraph
        spec={{ goal: 'g', steps: [{ id: 'a', agentId: 'x', prompt: 'p', dependsOn: ['a'] }] }}
      />
    );
    expect(container).toBeEmptyDOMElement();
  });
});
