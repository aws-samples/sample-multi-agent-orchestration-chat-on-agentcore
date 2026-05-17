/**
 * Tool State Management Store
 * Manages tool list and search state from AgentCore Gateway
 */

import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import type { MCPTool } from '../api/tools';
import { fetchTools, searchTools, checkGatewayHealth } from '../api/tools';
import { logger } from '../utils/logger';
import { extractErrorMessage } from '../utils/store-helpers';

/**
 * Tool store state type definition
 */
export interface ToolStoreState {
  // Tool list
  tools: MCPTool[];
  isLoading: boolean;
  error: string | null;
  lastFetchTime: string | null;
  nextCursor: string | null; // For pagination

  // Search functionality
  searchQuery: string;
  searchResults: MCPTool[];
  isSearching: boolean;
  searchError: string | null;

  // Gateway connection status
  gatewayHealthy: boolean;
  gatewayStatus: 'unknown' | 'healthy' | 'unhealthy';

  // Actions
  loadTools: () => Promise<void>;
  loadMoreTools: () => Promise<void>; // Load additional pages
  loadAllTools: () => Promise<void>; // Load all tools (for tool selection)
  searchToolsWithQuery: (query: string) => Promise<void>;
  clearSearch: () => void;
  setSearchQuery: (query: string) => void;
  checkGateway: () => Promise<void>;
  clearError: () => void;
}

/**
 * Tool management store
 */
export const useToolStore = create<ToolStoreState>()(
  devtools(
    (set, get) => ({
      // Initial state
      tools: [],
      isLoading: false,
      error: null,
      lastFetchTime: null,
      nextCursor: null,

      searchQuery: '',
      searchResults: [],
      isSearching: false,
      searchError: null,

      gatewayHealthy: false,
      gatewayStatus: 'unknown',

      /**
       * Load tool list (first page)
       */
      loadTools: async () => {
        const currentState = get();

        // Avoid duplicate execution if already loading
        if (currentState.isLoading) {
          logger.log('Tool list already loading, skipping duplicate execution');
          return;
        }

        set({
          isLoading: true,
          error: null,
          gatewayStatus: 'unknown',
          nextCursor: null,
        });

        try {
          logger.log('Tool list loading started');

          const result = await fetchTools();

          set({
            tools: result.tools,
            nextCursor: result.nextCursor || null,
            isLoading: false,
            error: null,
            lastFetchTime: new Date().toISOString(),
            gatewayHealthy: true,
            gatewayStatus: 'healthy',
          });

          logger.log(
            'Tool list loading completed: %d items',
            result.tools.length,
            result.nextCursor ? { nextCursor: 'present' } : { nextCursor: 'none' }
          );
        } catch (error) {
          const errorMessage = extractErrorMessage(error, 'Failed to load tool list');

          logger.error('Tool list loading error:', error);

          set({
            tools: [],
            nextCursor: null,
            isLoading: false,
            error: errorMessage,
            lastFetchTime: null,
            gatewayHealthy: false,
            gatewayStatus: 'unhealthy',
          });
        }
      },

      /**
       * Load additional page
       */
      loadMoreTools: async () => {
        const currentState = get();

        if (currentState.isLoading || !currentState.nextCursor) {
          logger.log('Cannot load more: loading in progress or no nextCursor');
          return;
        }

        set({
          isLoading: true,
          error: null,
        });

        try {
          logger.log('Loading additional tools started', { cursor: currentState.nextCursor });

          const result = await fetchTools(currentState.nextCursor);

          set({
            tools: [...currentState.tools, ...result.tools], // Add to existing tools
            nextCursor: result.nextCursor || null,
            isLoading: false,
            error: null,
            lastFetchTime: new Date().toISOString(),
            gatewayHealthy: true,
            gatewayStatus: 'healthy',
          });

          logger.log(
            'Additional tools loading completed: +%d items (total: %d items)',
            result.tools.length,
            currentState.tools.length + result.tools.length,
            result.nextCursor ? { nextCursor: 'present' } : { nextCursor: 'none' }
          );
        } catch (error) {
          const errorMessage = extractErrorMessage(error, 'Failed to load additional tools');

          logger.error('Additional tools loading error:', error);

          set({
            isLoading: false,
            error: errorMessage,
            gatewayHealthy: false,
            gatewayStatus: 'unhealthy',
          });
        }
      },

      /**
       * Load all tools (for tool selection)
       * Automatically loads all pages while nextCursor exists
       */
      loadAllTools: async () => {
        const currentState = get();

        // Avoid duplicate execution if already loading
        if (currentState.isLoading) {
          logger.log('All tools already loading, skipping duplicate execution');
          return;
        }

        set({
          isLoading: true,
          error: null,
          gatewayStatus: 'unknown',
        });

        try {
          logger.log('Loading all tools started');

          let allTools: MCPTool[] = [];
          let cursor: string | undefined = undefined;

          // Repeat loading while nextCursor exists
          do {
            const result = await fetchTools(cursor);
            allTools = [...allTools, ...result.tools];
            cursor = result.nextCursor;

            logger.log(
              'Page loaded: +%d items (total: %d items)',
              result.tools.length,
              allTools.length,
              cursor ? { nextCursor: 'present' } : { nextCursor: 'none' }
            );
          } while (cursor);

          set({
            tools: allTools,
            nextCursor: null, // null as all loaded
            isLoading: false,
            error: null,
            lastFetchTime: new Date().toISOString(),
            gatewayHealthy: true,
            gatewayStatus: 'healthy',
          });

          logger.log(`All tools loading completed: ${allTools.length} items`);
        } catch (error) {
          const errorMessage = extractErrorMessage(error, 'Failed to load all tools');

          logger.error('All tools loading error:', error);

          set({
            tools: [],
            nextCursor: null,
            isLoading: false,
            error: errorMessage,
            lastFetchTime: null,
            gatewayHealthy: false,
            gatewayStatus: 'unhealthy',
          });
        }
      },

      /**
       * Execute tool search
       */
      searchToolsWithQuery: async (query: string) => {
        if (!query || query.trim().length === 0) {
          set({
            searchQuery: '',
            searchResults: [],
            searchError: 'Please enter a search query',
          });
          return;
        }

        const trimmedQuery = query.trim();

        set({
          searchQuery: trimmedQuery,
          isSearching: true,
          searchError: null,
          searchResults: [],
        });

        try {
          logger.log(`Tool search started: "${trimmedQuery}"`);

          // Search via Backend API (builtin tools + MCP tools)
          const searchResults = await searchTools(trimmedQuery);

          set({
            searchResults,
            isSearching: false,
            searchError: null,
            gatewayHealthy: true,
            gatewayStatus: 'healthy',
          });

          logger.log(
            `Tool search completed: ${searchResults.length} items (query: "${trimmedQuery}")`
          );
        } catch (error) {
          const errorMessage = extractErrorMessage(error, 'Tool search failed');

          logger.error('Tool search error:', error);

          set({
            searchResults: [],
            isSearching: false,
            searchError: errorMessage,
            gatewayHealthy: false,
            gatewayStatus: 'unhealthy',
          });
        }
      },

      /**
       * Clear search state
       */
      clearSearch: () => {
        logger.log('Clearing search state');
        set({
          searchQuery: '',
          searchResults: [],
          isSearching: false,
          searchError: null,
        });
      },

      /**
       * Set search query
       */
      setSearchQuery: (query: string) => {
        set({
          searchQuery: query,
        });
      },

      /**
       * Check Gateway connection status
       */
      checkGateway: async () => {
        try {
          logger.log('Gateway connection check started');

          const healthResponse = await checkGatewayHealth();

          set({
            gatewayHealthy: healthResponse.gateway.connected,
            gatewayStatus: healthResponse.status,
          });

          logger.log(`Gateway connection check completed: ${healthResponse.status}`);
        } catch (error) {
          logger.error('Gateway connection check error:', error);

          set({
            gatewayHealthy: false,
            gatewayStatus: 'unhealthy',
          });
        }
      },

      /**
       * Clear error state
       */
      clearError: () => {
        set({
          error: null,
          searchError: null,
        });
      },
    }),
    {
      name: 'tool-store',
      // Enable only in development
      enabled: import.meta.env.DEV,
    }
  )
);
