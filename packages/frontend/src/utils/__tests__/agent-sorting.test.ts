import { describe, it, expect } from 'vitest';
import { sortAgents, parseSortValue, filterAgentsByQuery } from '../agent-sorting';
import type { Agent } from '../../types/agent';
import type { AgentId } from '@moca/core';
import type { TFunction } from 'i18next';

const mockT: TFunction = ((key: string) => key) as unknown as TFunction;

/**
 * These sorting/filtering tests identify agents by short human-readable labels
 * (e.g. '1', '2') rather than UUIDs. The `agentId` field is branded as
 * {@link AgentId}, so the helper casts at the type boundary — runtime validation
 * is intentionally skipped here because the tests exercise comparators that do
 * not care about the ID's format.
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

describe('sortAgents', () => {
  const agents: Agent[] = [
    createAgent({
      agentId: '1',
      name: 'Charlie',
      createdAt: new Date('2025-03-01'),
      updatedAt: new Date('2025-04-01'),
    }),
    createAgent({
      agentId: '2',
      name: 'Alice',
      createdAt: new Date('2025-01-01'),
      updatedAt: new Date('2025-05-01'),
    }),
    createAgent({
      agentId: '3',
      name: 'Bob',
      createdAt: new Date('2025-02-01'),
      updatedAt: new Date('2025-03-01'),
    }),
  ];

  it('sorts by name ascending', () => {
    const result = sortAgents(agents, { field: 'name', order: 'asc' }, mockT);
    expect(result.map((a) => a.name)).toEqual(['Alice', 'Bob', 'Charlie']);
  });

  it('sorts by name descending', () => {
    const result = sortAgents(agents, { field: 'name', order: 'desc' }, mockT);
    expect(result.map((a) => a.name)).toEqual(['Charlie', 'Bob', 'Alice']);
  });

  it('sorts by createdAt ascending', () => {
    const result = sortAgents(agents, { field: 'createdAt', order: 'asc' }, mockT);
    expect(result.map((a) => a.agentId)).toEqual(['2', '3', '1']);
  });

  it('sorts by createdAt descending', () => {
    const result = sortAgents(agents, { field: 'createdAt', order: 'desc' }, mockT);
    expect(result.map((a) => a.agentId)).toEqual(['1', '3', '2']);
  });

  it('sorts by updatedAt descending', () => {
    const result = sortAgents(agents, { field: 'updatedAt', order: 'desc' }, mockT);
    expect(result.map((a) => a.agentId)).toEqual(['2', '1', '3']);
  });

  it('does not mutate the original array', () => {
    const original = [...agents];
    sortAgents(agents, { field: 'name', order: 'asc' }, mockT);
    expect(agents).toEqual(original);
  });

  it('sorts name case-insensitively', () => {
    const mixedCase = [
      createAgent({ agentId: '1', name: 'banana' }),
      createAgent({ agentId: '2', name: 'Apple' }),
    ];
    const result = sortAgents(mixedCase, { field: 'name', order: 'asc' }, mockT);
    expect(result.map((a) => a.name)).toEqual(['Apple', 'banana']);
  });

  it('uses translateIfKey for name sorting', () => {
    const translatingT = ((key: string) =>
      key === 'defaultAgents.assistant' ? 'Zebra' : key) as unknown as TFunction;
    const agentsWithKey = [
      createAgent({ agentId: '1', name: 'defaultAgents.assistant' }),
      createAgent({ agentId: '2', name: 'Alpha' }),
    ];
    const result = sortAgents(agentsWithKey, { field: 'name', order: 'asc' }, translatingT);
    expect(result.map((a) => a.agentId)).toEqual(['2', '1']);
  });
});

describe('parseSortValue', () => {
  it('parses "name-asc"', () => {
    expect(parseSortValue('name-asc')).toEqual({ field: 'name', order: 'asc' });
  });

  it('parses "createdAt-desc"', () => {
    expect(parseSortValue('createdAt-desc')).toEqual({ field: 'createdAt', order: 'desc' });
  });

  it('parses "updatedAt-desc"', () => {
    expect(parseSortValue('updatedAt-desc')).toEqual({ field: 'updatedAt', order: 'desc' });
  });
});

describe('filterAgentsByQuery', () => {
  const agents: Agent[] = [
    createAgent({ agentId: '1', name: 'Code Reviewer', description: 'Reviews pull requests' }),
    createAgent({ agentId: '2', name: 'Web Researcher', description: 'Searches the internet' }),
    createAgent({ agentId: '3', name: 'Translator', description: 'Translates code and text' }),
  ];

  it('returns all agents when query is empty', () => {
    expect(filterAgentsByQuery(agents, '', mockT)).toHaveLength(3);
  });

  it('returns all agents when query is whitespace only', () => {
    expect(filterAgentsByQuery(agents, '   ', mockT)).toHaveLength(3);
  });

  it('filters by name match', () => {
    const result = filterAgentsByQuery(agents, 'code', mockT);
    expect(result.map((a) => a.agentId)).toEqual(['1', '3']);
  });

  it('filters by description match', () => {
    const result = filterAgentsByQuery(agents, 'internet', mockT);
    expect(result.map((a) => a.agentId)).toEqual(['2']);
  });

  it('is case-insensitive', () => {
    const result = filterAgentsByQuery(agents, 'TRANSLATOR', mockT);
    expect(result.map((a) => a.agentId)).toEqual(['3']);
  });

  it('returns empty array when no match', () => {
    expect(filterAgentsByQuery(agents, 'nonexistent', mockT)).toHaveLength(0);
  });
});
