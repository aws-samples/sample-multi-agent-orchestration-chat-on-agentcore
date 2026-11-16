import { useEffect, useMemo } from 'react';
import { useChatStore } from '../stores/chatStore';
import { MAX_REFRESH_FAILURES, useWorkflowStore } from '../stores/workflowStore';
import { isTerminalWorkflowStatus, type WorkflowView } from '../api/workflows';
import { extractSessionWorkflowIds } from '../utils/session-workflows';

export const WORKFLOW_POLL_INTERVAL_MS = 15_000;
export const WORKFLOW_POLL_INTERVAL_FOCUSED_MS = 5_000;

/**
 * Keeps the given workflows (comma-joined ids, so callers can memo by value)
 * fresh while enabled: refreshes unfinished ones every `intervalMs`, and at
 * once when the tab becomes visible again. Polling pauses while hidden.
 */
export function useWorkflowPolling(
  idsKey: string,
  enabled: boolean,
  intervalMs: number = WORKFLOW_POLL_INTERVAL_MS
): void {
  const refresh = useWorkflowStore((s) => s.refresh);
  useEffect(() => {
    const ids = idsKey ? idsKey.split(',') : [];
    if (!enabled || ids.length === 0) return;
    const poll = () => {
      const { workflows } = useWorkflowStore.getState();
      for (const id of ids) {
        const entry = workflows[id];
        if ((entry?.failures ?? 0) >= MAX_REFRESH_FAILURES) continue;
        if (!entry?.data || !isTerminalWorkflowStatus(entry.data.status)) void refresh(id);
      }
    };
    // Also runs when the interval changes, so opening the modal refreshes at once.
    poll();
    const timer = setInterval(() => {
      if (document.visibilityState !== 'hidden') poll();
    }, intervalMs);
    const onVisible = () => {
      if (document.visibilityState === 'visible') poll();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [idsKey, enabled, intervalMs, refresh]);
}

/**
 * Workflows started in a session, newest first, kept fresh by polling while
 * any of them is still running. Polling pauses while the tab is hidden.
 */
export function useSessionWorkflows(
  sessionId: string | null,
  intervalMs: number = WORKFLOW_POLL_INTERVAL_MS
): WorkflowView[] {
  const messages = useChatStore((s) => (sessionId ? s.sessions[sessionId]?.messages : undefined));
  // Joined so a new message that starts no workflow does not reset polling.
  const idsKey = useMemo(() => extractSessionWorkflowIds(messages ?? []).join(','), [messages]);
  const entries = useWorkflowStore((s) => s.workflows);

  useWorkflowPolling(idsKey, true, intervalMs);

  return useMemo(() => {
    const ids = idsKey ? idsKey.split(',') : [];
    return ids
      .map((id) => entries[id]?.data)
      .filter((w): w is WorkflowView => w !== undefined)
      .reverse();
  }, [idsKey, entries]);
}
