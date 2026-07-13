/**
 * Settings Store
 * Application settings management Zustand store
 */

import { create } from 'zustand';
import { devtools, persist } from 'zustand/middleware';
import { isReasoningDepth, type ReasoningDepth } from '@moca/core';
import { DEFAULT_MODEL_ID, getModelById } from '../config/models';
import { logger } from '../utils/logger';

/**
 * Send behavior setting
 * - 'enter': Send with Enter, newline with Shift+Enter
 * - 'cmdEnter': Send with Cmd/Ctrl+Enter, newline with Enter
 */
export type SendBehavior = 'enter' | 'cmdEnter';

/**
 * A goal the user opted to keep applying to every message ("継続適用").
 *
 * The wire contract stays per-message: the agent never persists a goal.
 * Stickiness is purely client-side — MessageInput restores this into its local
 * goal state and re-attaches it on every send instead of clearing. One global
 * value (not per-agent / per-session) by design; stored in localStorage via
 * the zustand persist middleware, so it does NOT sync across devices.
 */
export interface PersistentGoal {
  text: string;
  /** Judge model id, or undefined for the server default. */
  judgeModelId?: string;
  /** GoalLoop attempt cap, or undefined for the server default. */
  maxAttempts?: number;
}

/**
 * Settings Store state
 */
interface SettingsState {
  // Enter key behavior setting
  sendBehavior: SendBehavior;

  // Selected model ID
  selectedModelId: string;

  /**
   * Reasoning (extended thinking) depth per model id. Keyed by modelId so
   * switching models restores that model's last-selected depth. Models with no
   * entry default to 'off'.
   */
  reasoningDepthByModel: Record<string, ReasoningDepth>;

  /**
   * Sticky goal re-attached to every send when set (see PersistentGoal).
   * null = no sticky goal (the default per-message behavior).
   */
  persistentGoal: PersistentGoal | null;

  // Actions
  setSendBehavior: (behavior: SendBehavior) => void;
  setSelectedModelId: (modelId: string) => void;
  setReasoningDepthFor: (modelId: string, depth: ReasoningDepth) => void;
  getReasoningDepthFor: (modelId: string) => ReasoningDepth;
  setPersistentGoal: (goal: PersistentGoal) => void;
  clearPersistentGoal: () => void;
}

/**
 * Settings Store
 */
export const useSettingsStore = create<SettingsState>()(
  devtools(
    persist(
      (set, get) => ({
        // Initial state: default is send with Enter
        sendBehavior: 'enter',

        // Initial state: default model
        selectedModelId: DEFAULT_MODEL_ID,

        // Initial state: no per-model reasoning depth (all default to 'off')
        reasoningDepthByModel: {},

        /**
         * Change Enter key behavior setting
         */
        setSendBehavior: (behavior: SendBehavior) => {
          set({ sendBehavior: behavior });
          logger.log(`[SettingsStore] Send behavior changed to: ${behavior}`);
        },

        /**
         * Change selected model ID
         */
        setSelectedModelId: (modelId: string) => {
          set({ selectedModelId: modelId });
          logger.log(`[SettingsStore] Model changed to: ${modelId}`);
        },

        /**
         * Set the reasoning depth for a specific model id.
         */
        setReasoningDepthFor: (modelId: string, depth: ReasoningDepth) => {
          set((state) => ({
            reasoningDepthByModel: { ...state.reasoningDepthByModel, [modelId]: depth },
          }));
          logger.log(`[SettingsStore] Reasoning depth for ${modelId}: ${depth}`);
        },

        /**
         * Get the reasoning depth for a model id (defaults to 'off').
         */
        getReasoningDepthFor: (modelId: string): ReasoningDepth => {
          return get().reasoningDepthByModel[modelId] ?? 'off';
        },

        // Initial state: no sticky goal
        persistentGoal: null,

        /**
         * Save a sticky goal. A whitespace-only goal is treated as clear —
         * an empty sticky goal would silently no-op on the agent side.
         */
        setPersistentGoal: (goal: PersistentGoal) => {
          const text = goal.text.trim();
          if (!text) {
            set({ persistentGoal: null });
            return;
          }
          set({
            persistentGoal: { text, judgeModelId: goal.judgeModelId, maxAttempts: goal.maxAttempts },
          });
          logger.log(`[SettingsStore] Persistent goal set (${text.length} chars)`);
        },

        /** Remove the sticky goal (reverts to per-message behavior). */
        clearPersistentGoal: () => {
          set({ persistentGoal: null });
          logger.log('[SettingsStore] Persistent goal cleared');
        },
      }),
      {
        onRehydrateStorage: () => (state) => {
          if (state && !getModelById(state.selectedModelId)) {
            state.selectedModelId = DEFAULT_MODEL_ID;
          }
          // Drop any persisted depth values that are no longer valid.
          if (state?.reasoningDepthByModel) {
            for (const [modelId, depth] of Object.entries(state.reasoningDepthByModel)) {
              if (!isReasoningDepth(depth)) {
                delete state.reasoningDepthByModel[modelId];
              }
            }
          }
          // Drop a malformed sticky goal (missing/empty text). A stale judge
          // model id is kept — the agent validates it and falls back to the
          // server default, so it degrades gracefully.
          if (state?.persistentGoal) {
            const text = state.persistentGoal.text;
            if (typeof text !== 'string' || !text.trim()) {
              state.persistentGoal = null;
            }
          }
        },
        name: 'app-settings',
      }
    ),
    {
      name: 'settings-store',
      enabled: import.meta.env.DEV,
    }
  )
);
