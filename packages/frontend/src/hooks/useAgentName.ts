import { useTranslation } from 'react-i18next';
import { useAgentStore } from '../stores/agentStore';
import { translateIfKey } from '../utils/agent-translation';

/** Display name for an agent id; unknown agents fall back to a shortened id. */
export function useAgentName(): (agentId: string) => string {
  const { t } = useTranslation();
  const agents = useAgentStore((state) => state.agents);
  return (agentId) => {
    const agent = agents.find((a) => a.agentId === agentId);
    return agent ? translateIfKey(agent.name, t) : `${agentId.slice(0, 8)}…`;
  };
}
