/**
 * Settings Store
 * Application settings management Zustand store
 */

import { create } from 'zustand';
import { devtools, persist } from 'zustand/middleware';
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

  // Actions
  setSendBehavior: (behavior: SendBehavior) => void;
  setSelectedModelId: (modelId: string) => void;
}

/**
 * Settings Store
 */
export const useSettingsStore = create<SettingsState>()(
  devtools(
    persist(
      (set) => ({
        // Initial state: default is send with Enter
        sendBehavior: 'enter',

        // Initial state: default model
        selectedModelId: DEFAULT_MODEL_ID,

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
      }),
      {
        onRehydrateStorage: () => (state) => {
          if (state && !getModelById(state.selectedModelId)) {
            state.selectedModelId = DEFAULT_MODEL_ID;
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
