// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter } from 'react-router-dom';
import { useState } from 'react';
import type { WorkflowView } from '../../../types/workflow';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${JSON.stringify(opts)}` : key,
    i18n: { language: 'en' },
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));
vi.mock('../../../stores/agentStore', () => ({
  useAgentStore: (sel: (s: { agents: unknown[] }) => unknown) =>
    sel({ agents: [{ agentId: 'agent-1', name: 'Researcher' }] }),
}));
const cancelWorkflow = vi.fn<(workflowId: string) => Promise<void>>(async () => {});
const getWorkflow = vi.fn();
vi.mock('../../../api/workflows', async (orig) => ({
  ...(await orig<typeof import('../../../api/workflows')>()),
  cancelWorkflow: (id: string) => cancelWorkflow(id),
  getWorkflow: (id: string) => getWorkflow(id),
}));

const { WorkflowStatusModal } = await import('../WorkflowStatusModal');
const { useWorkflowStore } = await import('../../../stores/workflowStore');

const base = {
  createdAt: new Date(Date.now() - 22 * 60_000).toISOString(),
  updatedAt: new Date().toISOString(),
};
const running: WorkflowView = {
  ...base,
  workflowId: 'wf-running',
  status: 'running',
  spec: {
    goal: 'Compare reports',
    steps: [
      { id: 'research', agentId: 'agent-1', prompt: 'Research' },
      { id: 'report', agentId: 'agent-1', prompt: 'Write', dependsOn: ['research'] },
    ],
  },
  steps: [
    { stepId: 'research', status: 'done', runs: 1, iteration: 0, sessionId: 's-1', ...base },
    {
      stepId: 'report',
      status: 'running',
      runs: 1,
      iteration: 2,
      sessionId: 's-2',
      feedback: 'Cite sources',
      startedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      ...base,
    },
  ],
};
const finished: WorkflowView = {
  ...running,
  workflowId: 'wf-done',
  status: 'completed',
  result: 'Status: completed\n\nSteps:\n- research (agent-1): done',
  completedAt: base.updatedAt,
  spec: { ...running.spec, goal: 'Weekly digest' },
  steps: running.steps.map((s) => ({
    ...s,
    status: 'done' as const,
    feedback: undefined,
    output: s.stepId === 'report' ? '## Final report\n\n**All good**' : undefined,
  })),
};

const Harness = ({ workflows }: { workflows: WorkflowView[] }) => {
  const [selectedId, setSelectedId] = useState<string>();
  return (
    <WorkflowStatusModal
      isOpen
      onClose={() => {}}
      workflows={workflows}
      selectedId={selectedId}
      onSelect={setSelectedId}
    />
  );
};
const renderModal = (workflows: WorkflowView[]) =>
  render(
    <MemoryRouter>
      <Harness workflows={workflows} />
    </MemoryRouter>
  );

beforeEach(() => {
  cancelWorkflow.mockClear();
  getWorkflow.mockReset().mockResolvedValue(running);
  useWorkflowStore.setState({ workflows: {}, seen: [] });
});

describe('WorkflowStatusModal', () => {
  it('summarises the running workflow and opens on its active step', () => {
    renderModal([running]);
    expect(screen.getByRole('heading', { name: 'Compare reports' })).toBeInTheDocument();
    expect(screen.getByText(/workflowStatus.progress:\{"done":1,"total":2\}/)).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '1');
    // Default selection = the running step, with its reviewer feedback and session link.
    expect(screen.getByText('Cite sources')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /workflowStatus.openSession/ })).toHaveAttribute(
      'href',
      '/chat/s-2'
    );
    // A single workflow needs no tabs.
    expect(screen.queryByRole('tablist')).toBeNull();
  });

  it('asks for confirmation before stopping', async () => {
    renderModal([running]);
    fireEvent.click(screen.getByRole('button', { name: /workflowStatus.stop/ }));
    expect(cancelWorkflow).not.toHaveBeenCalled();
    const confirm = screen.getAllByRole('button', { name: 'workflowStatus.stop' }).at(-1)!;
    fireEvent.click(confirm);
    await waitFor(() => expect(cancelWorkflow).toHaveBeenCalledWith('wf-running'));
  });

  it('switches between workflows and marks finished ones as seen', () => {
    renderModal([finished, running]);
    // The running workflow is shown first even though it is not the newest.
    expect(screen.getByRole('heading', { name: 'Compare reports' })).toBeInTheDocument();
    expect(useWorkflowStore.getState().seen).toEqual([]);
    fireEvent.click(screen.getByRole('tab', { name: /Weekly digest/ }));
    // The final step's output is the result, rendered as Markdown; the
    // agent-facing summary is not shown.
    expect(screen.getByRole('heading', { name: 'Final report' })).toBeInTheDocument();
    expect(screen.getByText('All good').tagName).toBe('STRONG');
    expect(screen.queryByText(/Status: completed/)).toBeNull();
    expect(screen.queryByRole('button', { name: /workflowStatus.stop/ })).toBeNull();
    expect(useWorkflowStore.getState().seen).toEqual(['wf-done']);
  });

  it('shows the graph first, then the instruction, then the result', () => {
    renderModal([finished]);
    const graph = screen.getByRole('group');
    const instruction = screen.getByRole('heading', { name: 'workflowStatus.instruction' });
    const result = screen.getByRole('heading', { name: 'workflowStatus.result' });
    const follows = (a: Element, b: Element) =>
      Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(follows(graph, instruction)).toBe(true);
    expect(follows(instruction, result)).toBe(true);
  });
});
