/**
 * Workflow Store
 * Latest polled state of run_workflow executions, shared by the status
 * launcher above the composer and the workflow graph inside chat messages.
 */

import { create } from 'zustand';
import { devtools, persist } from 'zustand/middleware';
import * as workflowsApi from '../api/workflows';
import type { WorkflowView } from '../api/workflows';
import { logger } from '../utils/logger';

/** Cap on remembered "seen" ids so localStorage does not grow without bound. */
const MAX_SEEN = 200;

/** Consecutive failures after which polling gives up (e.g. the record expired). */
export const MAX_REFRESH_FAILURES = 3;

interface WorkflowEntry {
  data?: WorkflowView;
  error?: string;
  failures?: number;
}

interface WorkflowState {
  workflows: Record<string, WorkflowEntry>;
  /** Terminal workflows the user has already looked at, oldest first. */
  seen: string[];
  refresh: (workflowId: string) => Promise<void>;
  cancel: (workflowId: string) => Promise<void>;
  markSeen: (workflowId: string) => void;
}

const inFlight = new Set<string>();

export const useWorkflowStore = create<WorkflowState>()(
  devtools(
    persist(
      (set, get) => ({
        workflows: {},
        seen: [],

        refresh: async (workflowId) => {
          // Overlapping polls (interval + modal open) would race each other.
          if (inFlight.has(workflowId)) return;
          inFlight.add(workflowId);
          try {
            const data = await workflowsApi.getWorkflow(workflowId);
            set((s) => ({ workflows: { ...s.workflows, [workflowId]: { data } } }));
          } catch (error) {
            logger.warn('[workflowStore] refresh failed:', error);
            const message = error instanceof Error ? error.message : String(error);
            set((s) => ({
              workflows: {
                ...s.workflows,
                [workflowId]: {
                  ...s.workflows[workflowId],
                  error: message,
                  failures: (s.workflows[workflowId]?.failures ?? 0) + 1,
                },
              },
            }));
          } finally {
            inFlight.delete(workflowId);
          }
        },

        cancel: async (workflowId) => {
          await workflowsApi.cancelWorkflow(workflowId);
          await get().refresh(workflowId);
        },

        markSeen: (workflowId) => {
          if (get().seen.includes(workflowId)) return;
          set((s) => ({ seen: [...s.seen, workflowId].slice(-MAX_SEEN) }));
        },
      }),
      {
        name: 'workflow-store',
        partialize: (state) => ({ seen: state.seen }),
      }
    ),
    { name: 'workflow-store' }
  )
);
