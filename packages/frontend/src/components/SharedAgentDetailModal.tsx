/**
 * Shared Agent Detail Modal
 * Displays detailed information of a shared agent and provides functionality to add it to My Agents
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { X, User } from 'lucide-react';
import * as icons from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { Agent } from '../types/agent';
import { translateIfKey } from '../utils/agent-translation';
import { useSharedAgentStore } from '../stores/sharedAgentStore';
import { useAgentStore } from '../stores/agentStore';
import { useAuthStore } from '../stores/authStore';
import { useUIStore } from '../stores/uiStore';
import { Button } from './ui/Button';
import { Badge } from './ui/Badge';
import { logger } from '../utils/logger';

interface SharedAgentDetailModalProps {
  agent: Agent | null;
  onClose: () => void;
}

export const SharedAgentDetailModal: React.FC<SharedAgentDetailModalProps> = ({
  agent,
  onClose,
}) => {
  const { t } = useTranslation();
  const { user } = useAuthStore();
  const { cloneAgent, fetchSharedAgents } = useSharedAgentStore();
  const { initializeStore: refreshAgents, toggleShare } = useAgentStore();
  const [isCloning, setIsCloning] = React.useState(false);
  const [isUnsharing, setIsUnsharing] = React.useState(false);
  const { isMobileView } = useUIStore();

  if (!agent) return null;

  const AgentIcon = (icons[agent.icon as keyof typeof icons] as LucideIcon) || icons.Bot;

  // Check if own agent (compare by userId)
  const isOwnAgent = user?.userId === agent.userId;

  // Add to my agents
  const handleAddToMyAgents = async () => {
    setIsCloning(true);
    try {
      // All agents (including system defaults) use the same clone path
      if (!agent.userId) {
        toast.error(t('agentDirectory.userIdNotFound'));
        return;
      }
      await cloneAgent(agent.userId, agent.agentId);

      await refreshAgents();
      toast.success(t('agentDirectory.addSuccess'));
      onClose();
    } catch (error) {
      logger.error('Failed to add agent:', error);
      toast.error(t('agentDirectory.addFailed'));
    } finally {
      setIsCloning(false);
    }
  };

  // Unshare
  const handleUnshare = async () => {
    setIsUnsharing(true);
    try {
      await toggleShare(agent.agentId); // Update agentStore
      await fetchSharedAgents(); // Update shared agent list
      toast.success(t('agentDirectory.unshareSuccess'));
      onClose();
    } catch (error) {
      logger.error('Failed to unshare agent:', error);
      toast.error(t('agentDirectory.unshareFailed'));
    } finally {
      setIsUnsharing(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />

      {/* Modal */}
      <div className="relative bg-surface-primary rounded-2xl shadow-xl max-w-5xl w-full mx-4 max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-card bg-surface-secondary flex items-center justify-center">
              <AgentIcon className="w-6 h-6 text-fg-secondary" />
            </div>
            <div>
              <h2 className="text-xl font-semibold text-fg-default">
                {translateIfKey(agent.name, t)}
              </h2>
              <p className="text-sm text-fg-secondary">{translateIfKey(agent.description, t)}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-fg-disabled hover:text-fg-secondary rounded-btn hover:bg-surface-secondary transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 min-h-0">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 h-full">
            {/* Left side: System Prompt */}
            <div className="flex flex-col min-h-0">
              <h3 className="text-sm font-semibold text-fg-default mb-3">
                {t('agent.systemPromptLabel2')}
              </h3>
              <div className="bg-surface-secondary rounded-card p-4 flex-1 overflow-y-auto max-h-[50vh]">
                <pre className="text-sm text-fg-secondary whitespace-pre-wrap font-mono">
                  {agent.systemPrompt}
                </pre>
              </div>
            </div>

            {/* Right side: Tools & Scenarios */}
            <div className="space-y-6">
              {/* Tools */}
              <div>
                <h3 className="text-sm font-semibold text-fg-default mb-3">
                  {t('agent.toolsLabel')}
                </h3>
                <div className="flex flex-wrap gap-2">
                  {agent.enabledTools.map((tool) => (
                    <Badge key={tool} variant="info">
                      {tool}
                    </Badge>
                  ))}
                </div>
              </div>

              {/* Scenarios */}
              <div>
                <h3 className="text-sm font-semibold text-fg-default mb-3">
                  {t('agent.scenarioLabel')}
                </h3>
                <div className="space-y-2">
                  {agent.scenarios.map((scenario) => (
                    <div
                      key={scenario.id}
                      className="bg-surface-secondary rounded-card p-3 hover:bg-surface-secondary transition-colors"
                    >
                      <h4 className="text-sm font-medium text-fg-default mb-1">
                        {translateIfKey(scenario.title, t)}
                      </h4>
                      <p className="text-xs text-fg-secondary line-clamp-2">
                        {translateIfKey(scenario.prompt, t)}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-border">
          {/* Author info */}
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-full bg-surface-secondary flex items-center justify-center">
              <User className="w-4 h-4 text-fg-secondary" />
            </div>
            <span className="text-sm text-fg-secondary">
              <span className="font-medium">{agent.createdBy}</span>
            </span>
          </div>

          {/* Action buttons */}
          <div className="flex items-center gap-3">
            {!isMobileView && (
              <Button variant="outline" size="md" onClick={onClose}>
                {t('common.close')}
              </Button>
            )}
            {isOwnAgent ? (
              <Button variant="danger" size="md" onClick={handleUnshare} loading={isUnsharing}>
                {isUnsharing ? t('agentDirectory.unsharing') : t('agentDirectory.unshare')}
              </Button>
            ) : (
              <Button variant="primary" size="md" onClick={handleAddToMyAgents} loading={isCloning}>
                {isCloning
                  ? t('agentDirectory.addingToMyAgents')
                  : t('agentDirectory.addToMyAgents')}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
