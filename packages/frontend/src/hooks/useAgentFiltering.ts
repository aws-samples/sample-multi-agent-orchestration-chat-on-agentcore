/**
 * useAgentFiltering hook
 * Encapsulates agent filtering, sorting, and pin-based grouping logic.
 */

import { useMemo } from 'react';
import type { TFunction } from 'i18next';
import type { Agent, AgentSortConfig } from '../types/agent';
import { sortAgents, filterAgentsByQuery } from '../utils/agent-sorting';

interface AgentFilteringResult {
  filteredAgents: Agent[];
  pinnedAgents: Agent[];
  unpinnedAgents: Agent[];
}

export function useAgentFiltering(
  agents: Agent[],
  pinnedAgentIds: string[],
  searchQuery: string,
  sortConfig: AgentSortConfig,
  t: TFunction
): AgentFilteringResult {
  const filteredAgents = useMemo(
    () => filterAgentsByQuery(agents, searchQuery, t),
    [agents, searchQuery, t]
  );

  const pinnedAgents = useMemo(() => {
    const pinned = filteredAgents.filter((agent) => pinnedAgentIds.includes(agent.agentId));
    return sortAgents(pinned, sortConfig, t);
  }, [filteredAgents, pinnedAgentIds, sortConfig, t]);

  const unpinnedAgents = useMemo(() => {
    const unpinned = filteredAgents.filter((agent) => !pinnedAgentIds.includes(agent.agentId));
    return sortAgents(unpinned, sortConfig, t);
  }, [filteredAgents, pinnedAgentIds, sortConfig, t]);

  return { filteredAgents, pinnedAgents, unpinnedAgents };
}
