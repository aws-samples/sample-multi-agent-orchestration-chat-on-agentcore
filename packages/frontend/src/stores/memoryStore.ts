/**
 * Memory Store
 * AgentCore Memory management Zustand store
 */

import { create } from 'zustand';
import { devtools, persist } from 'zustand/middleware';
import {
  fetchMemoryRecords,
  searchMemoryRecords as apiSearchMemoryRecords,
  type MemoryRecord,
} from '../api/memory';
import { logger } from '../utils/logger';
import { extractErrorMessage } from '../utils/store-helpers';

/**
 * Memory Store state
 */
interface MemoryState {
  // Memory reference ON/OFF setting
  isMemoryEnabled: boolean;

  // Memory records
  records: MemoryRecord[];

  // Loading state
  isLoading: boolean;
  isLoadingMore: boolean;

  // Error state
  error: string | null;

  // Pagination
  nextToken?: string;

  // Actions
  setMemoryEnabled: (enabled: boolean) => void;
  loadMemoryRecords: () => Promise<void>;
  loadMoreMemoryRecords: () => Promise<void>;
  searchMemoryRecords: (query: string) => Promise<MemoryRecord[]>;
  clearError: () => void;
}

/**
 * Memory Store
 */
export const useMemoryStore = create<MemoryState>()(
  devtools(
    persist(
      (set, get) => ({
        // Initial state
        isMemoryEnabled: true, // Default is ON
        records: [],
        isLoading: false,
        isLoadingMore: false,
        error: null,

        /**
         * Set memory reference ON/OFF
         */
        setMemoryEnabled: (enabled: boolean) => {
          set({ isMemoryEnabled: enabled });
          logger.log(`[MemoryStore] Memory enabled: ${enabled}`);
        },

        /**
         * Load memory record list
         */
        loadMemoryRecords: async () => {
          try {
            set({ isLoading: true, error: null });

            const data = await fetchMemoryRecords();

            set({
              records: data.records,
              nextToken: data.nextToken,
            });

            logger.log(`[MemoryStore] Loaded ${data.records.length} records`);
          } catch (error) {
            const errorMessage = extractErrorMessage(error, 'Failed to load memory records');
            set({ error: errorMessage });
            logger.error('[MemoryStore] Error loading records:', error);
          } finally {
            set({ isLoading: false });
          }
        },

        /**
         * Load next page of memory records (append to existing list)
         */
        loadMoreMemoryRecords: async () => {
          const { nextToken } = get();
          if (!nextToken) return;

          try {
            set({ isLoadingMore: true, error: null });

            const data = await fetchMemoryRecords(nextToken);

            set((state) => ({
              records: [...state.records, ...data.records],
              nextToken: data.nextToken,
            }));

            logger.log(`[MemoryStore] Loaded ${data.records.length} more records`);
          } catch (error) {
            const errorMessage = extractErrorMessage(error, 'Failed to load more memory records');
            set({ error: errorMessage });
            logger.error('[MemoryStore] Error loading more records:', error);
          } finally {
            set({ isLoadingMore: false });
          }
        },

        /**
         * Semantic search memory records
         */
        searchMemoryRecords: async (query: string): Promise<MemoryRecord[]> => {
          try {
            const records = await apiSearchMemoryRecords({
              query,
              topK: 20,
              relevanceScore: 0.2,
            });

            logger.log(`[MemoryStore] Found ${records.length} records for query: "${query}"`);
            return records;
          } catch (error) {
            logger.error('[MemoryStore] Error searching memory records:', error);
            return [];
          }
        },

        /**
         * Clear errors
         */
        clearError: () => {
          set({ error: null });
        },
      }),
      {
        name: 'memory-settings',
        // Only persist memory reference setting (records are fetched each time)
        partialize: (state) => ({
          isMemoryEnabled: state.isMemoryEnabled,
        }),
      }
    ),
    {
      name: 'memory-store',
      enabled: import.meta.env.DEV,
    }
  )
);
