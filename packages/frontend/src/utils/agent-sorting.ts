/**
 * Agent Sorting & Filtering Utilities
 * Pure functions for sorting, filtering, and grouping agents.
 */

import type { TFunction } from 'i18next';
import type { Agent, AgentSortConfig, AgentSortField, SortOrder } from '../types/agent';
import { translateIfKey } from './agent-translation';

/**
 * Sort agents by the given configuration.
 * Returns a new array without mutating the original.
 */
export function sortAgents(agents: Agent[], config: AgentSortConfig, t: TFunction): Agent[] {
  return [...agents].sort((a, b) => {
    let aValue: string | Date;
    let bValue: string | Date;

    switch (config.field) {
      case 'name':
        aValue = translateIfKey(a.name, t).toLowerCase();
        bValue = translateIfKey(b.name, t).toLowerCase();
        break;
      case 'createdAt':
        aValue = new Date(a.createdAt);
        bValue = new Date(b.createdAt);
        break;
      case 'updatedAt':
        aValue = new Date(a.updatedAt);
        bValue = new Date(b.updatedAt);
        break;
      default:
        return 0;
    }

    if (aValue < bValue) return config.order === 'asc' ? -1 : 1;
    if (aValue > bValue) return config.order === 'asc' ? 1 : -1;
    return 0;
  });
}

/**
 * Parse a sort select value (e.g. "name-asc") into an AgentSortConfig.
 */
export function parseSortValue(value: string): AgentSortConfig {
  const [field, order] = value.split('-') as [AgentSortField, SortOrder];
  return { field, order };
}

/**
 * Filter agents by a search query against name and description.
 * Returns all agents when the query is empty or whitespace-only.
 */
export function filterAgentsByQuery(agents: Agent[], query: string, t: TFunction): Agent[] {
  const trimmed = query.trim();
  if (!trimmed) {
    return agents;
  }

  const lowerQuery = trimmed.toLowerCase();
  return agents.filter((agent) => {
    const name = translateIfKey(agent.name, t).toLowerCase();
    const description = translateIfKey(agent.description, t).toLowerCase();
    return name.includes(lowerQuery) || description.includes(lowerQuery);
  });
}
