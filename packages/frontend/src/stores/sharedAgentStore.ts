/**
 * Shared Agent management Zustand store (with pagination)
 */

import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import type { Agent } from '../types/agent';
import * as agentsApi from '../api/agents';
import { logger } from '../utils/logger';
import { extractErrorMessage } from '../utils/store-helpers';

interface SharedAgentState {
  sharedAgents: Agent[];
  isLoading: boolean;
  isLoadingMore: boolean;
  error: string | null;
  searchQuery: string;
  nextCursor: string | null;
  hasMore: boolean;
}

interface SharedAgentActions {
  fetchSharedAgents: (searchQuery?: string) => Promise<void>;
  loadMoreAgents: () => Promise<void>;
  resetPagination: () => void;
  setSearchQuery: (query: string) => void;
  cloneAgent: (userId: string, agentId: string) => Promise<Agent>;
  clearError: () => void;
}

export type SharedAgentStore = SharedAgentState & SharedAgentActions;

export const useSharedAgentStore = create<SharedAgentStore>()(
  devtools(
    (set, get) => ({
      // Initial state
      sharedAgents: [],
      isLoading: false,
      isLoadingMore: false,
      error: null,
      searchQuery: '',
      nextCursor: null,
      hasMore: false,

      // Fetch shared agent list (initial or search query change)
      fetchSharedAgents: async (searchQuery?: string) => {
        set({ isLoading: true, error: null });

        try {
          const query = searchQuery !== undefined ? searchQuery : get().searchQuery;
          logger.log('Fetching shared agents...', { query });

          const result = await agentsApi.listSharedAgents(query || undefined, 20);

          logger.log(
            `Shared agents fetched: ${result.agents.length} items (hasMore: ${result.hasMore})`
          );

          set({
            sharedAgents: result.agents,
            nextCursor: result.nextCursor || null,
            hasMore: result.hasMore,
            isLoading: false,
            error: null,
          });
        } catch (error) {
          const errorMessage = extractErrorMessage(error, 'Failed to fetch shared agents');
          logger.error('Shared agents fetch error:', error);
          set({
            sharedAgents: [],
            nextCursor: null,
            hasMore: false,
            isLoading: false,
            error: errorMessage,
          });
        }
      },

      // Load more agents (pagination)
      loadMoreAgents: async () => {
        const { nextCursor, isLoadingMore, searchQuery } = get();

        if (!nextCursor || isLoadingMore) {
          return;
        }

        set({ isLoadingMore: true, error: null });

        try {
          logger.log('Loading more agents...', { cursor: nextCursor });

          const result = await agentsApi.listSharedAgents(searchQuery || undefined, 20, nextCursor);

          logger.log(
            `More agents loaded: ${result.agents.length} items (hasMore: ${result.hasMore})`
          );

          set((state) => ({
            sharedAgents: [...state.sharedAgents, ...result.agents],
            nextCursor: result.nextCursor || null,
            hasMore: result.hasMore,
            isLoadingMore: false,
            error: null,
          }));
        } catch (error) {
          const errorMessage = extractErrorMessage(error, 'Failed to load more agents');
          logger.error('Load more agents error:', error);
          set({
            isLoadingMore: false,
            error: errorMessage,
          });
        }
      },

      // Reset pagination
      resetPagination: () => {
        set({
          sharedAgents: [],
          nextCursor: null,
          hasMore: false,
        });
      },

      // Update search query
      setSearchQuery: (query: string) => {
        set({ searchQuery: query });
      },

      // Clone shared agent to my agents
      cloneAgent: async (userId: string, agentId: string) => {
        set({ isLoading: true, error: null });

        try {
          logger.log('Cloning shared agent...', { userId, agentId });

          const clonedAgent = await agentsApi.cloneSharedAgent(userId, agentId);

          logger.log(`Shared agent cloned: ${clonedAgent.agentId}`);

          set({ isLoading: false, error: null });

          return clonedAgent;
        } catch (error) {
          const errorMessage = extractErrorMessage(error, 'Failed to clone shared agent');
          logger.error('Shared agent clone error:', error);
          set({ isLoading: false, error: errorMessage });
          throw error;
        }
      },

      // Clear error
      clearError: () => {
        set({ error: null });
      },
    }),
    {
      name: 'shared-agent-store',
      enabled: import.meta.env.DEV,
    }
  )
);
