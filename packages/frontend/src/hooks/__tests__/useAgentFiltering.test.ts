import { describe, it, expect } from 'vitest';
import { sortAgents, filterAgentsByQuery } from '../../utils/agent-sorting';
import type { Agent, AgentSortConfig } from '../../types/agent';
import type { AgentId } from '@moca/core';
import type { TFunction } from 'i18next';

/**
 * Integration tests for the filtering + sorting + pin grouping logic
 * used by useAgentFiltering hook.
 *
 * Since useAgentFiltering is a thin composition of pure functions with useMemo,
 * we test the composed logic directly without React rendering.
 */

const mockT: TFunction = ((key: string) => key) as unknown as TFunction;

/**
 * `agentId` is branded {@link AgentId}, but these tests use short labels for
 * readability. The helper casts at the boundary — the filtering/sorting logic
 * under test does not inspect ID format.
 */
type AgentOverrides = Partial<Omit<Agent, 'agentId'>> & { agentId?: string };

const createAgent = ({ agentId, ...rest }: AgentOverrides): Agent => ({
  agentId: (agentId ?? 'agent-1') as AgentId,
  name: 'Agent A',
  description: 'Description A',
  icon: 'Bot',
  systemPrompt: '',
  enabledTools: [],
  scenarios: [],
  createdAt: new Date('2025-01-01'),
  updatedAt: new Date('2025-01-01'),
  isShared: false,
  createdBy: 'user1',
  ...rest,
});

const defaultSort: AgentSortConfig = { field: 'createdAt', order: 'desc' };

function applyAgentFiltering(
  agents: Agent[],
  pinnedAgentIds: string[],
  searchQuery: string,
  sortConfig: AgentSortConfig,
  t: TFunction
) {
  const filteredAgents = filterAgentsByQuery(agents, searchQuery, t);
  const pinnedAgents = sortAgents(
    filteredAgents.filter((a) => pinnedAgentIds.includes(a.agentId)),
    sortConfig,
    t
  );
  const unpinnedAgents = sortAgents(
    filteredAgents.filter((a) => !pinnedAgentIds.includes(a.agentId)),
    sortConfig,
    t
  );
  return { filteredAgents, pinnedAgents, unpinnedAgents };
}

describe('agent filtering + sorting + pin grouping (useAgentFiltering logic)', () => {
  const agents: Agent[] = [
    createAgent({ agentId: '1', name: 'Alpha', createdAt: new Date('2025-01-01') }),
    createAgent({ agentId: '2', name: 'Beta', createdAt: new Date('2025-03-01') }),
    createAgent({ agentId: '3', name: 'Gamma', createdAt: new Date('2025-02-01') }),
  ];

  it('returns all agents as unpinned when no pins', () => {
    const result = applyAgentFiltering(agents, [], '', defaultSort, mockT);
    expect(result.pinnedAgents).toHaveLength(0);
    expect(result.unpinnedAgents).toHaveLength(3);
  });

  it('separates pinned and unpinned agents', () => {
    const result = applyAgentFiltering(agents, ['2'], '', defaultSort, mockT);
    expect(result.pinnedAgents.map((a) => a.agentId)).toEqual(['2']);
    expect(result.unpinnedAgents.map((a) => a.agentId)).toContain('1');
    expect(result.unpinnedAgents.map((a) => a.agentId)).toContain('3');
  });

  it('applies search filter to both pinned and unpinned', () => {
    const result = applyAgentFiltering(agents, ['1'], 'beta', defaultSort, mockT);
    expect(result.pinnedAgents).toHaveLength(0);
    expect(result.unpinnedAgents).toHaveLength(1);
    expect(result.unpinnedAgents[0].agentId).toBe('2');
  });

  it('sorts both groups according to sortConfig', () => {
    const result = applyAgentFiltering(agents, [], '', { field: 'name', order: 'asc' }, mockT);
    expect(result.unpinnedAgents.map((a) => a.name)).toEqual(['Alpha', 'Beta', 'Gamma']);
  });

  it('returns filteredAgents containing all matching agents regardless of pin state', () => {
    const result = applyAgentFiltering(agents, ['1'], '', defaultSort, mockT);
    expect(result.filteredAgents).toHaveLength(3);
  });

  it('pinned agents are also sorted', () => {
    const result = applyAgentFiltering(
      agents,
      ['3', '1'],
      '',
      { field: 'name', order: 'asc' },
      mockT
    );
    expect(result.pinnedAgents.map((a) => a.name)).toEqual(['Alpha', 'Gamma']);
  });
});
