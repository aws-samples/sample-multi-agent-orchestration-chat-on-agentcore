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

  // Actions
  setSendBehavior: (behavior: SendBehavior) => void;
  setSelectedModelId: (modelId: string) => void;
  setReasoningDepthFor: (modelId: string, depth: ReasoningDepth) => void;
  getReasoningDepthFor: (modelId: string) => ReasoningDepth;
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
