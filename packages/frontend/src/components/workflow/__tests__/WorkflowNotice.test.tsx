// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { WORKFLOW_STATUS_OPEN_EVENT } from '../../../utils/workflow-events';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${JSON.stringify(opts)}` : key,
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

const { Message } = await import('../../Message');

const WF = 'wf-01a1c7ae-91c0-7702-be2d-31a23e956e3a';

describe('workflow completion notice', () => {
  it('replaces the internal resume prompt and opens the status modal', () => {
    const listener = vi.fn();
    window.addEventListener(WORKFLOW_STATUS_OPEN_EVENT, listener);
    render(
      <Message
        message={{
          id: 'm1',
          type: 'user',
          timestamp: new Date(),
          contents: [
            {
              type: 'text',
              text: `[Workflow finished] The background workflow ${WF} you started has finished.\n\nGoal: Compare habits\n\nStatus: completed\n\nReport the outcome to the user.`,
            },
          ],
        }}
      />
    );
    expect(
      screen.getByText('workflowStatus.notice.completed:{"goal":"Compare habits"}')
    ).toBeInTheDocument();
    expect(screen.queryByText(/Report the outcome/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'workflowStatus.notice.show' }));
    expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual({ workflowId: WF });
    window.removeEventListener(WORKFLOW_STATUS_OPEN_EVENT, listener);
  });
});
