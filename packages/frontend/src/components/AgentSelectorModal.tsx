import React, { useState, useEffect, useCallback } from 'react';
import toast from 'react-hot-toast';
import {
  Plus,
  Bot,
  MoreHorizontal,
  Edit2,
  Trash2,
  Share2,
  Search,
  X,
  Pin,
  PinOff,
  ArrowUpDown,
} from 'lucide-react';
import * as icons from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { AgentForm } from './AgentForm';
import { Modal, ConfirmModal } from './ui/Modal';
import { LoadingIndicator } from './ui/LoadingIndicator/LoadingIndicator';
import { useAgentStore } from '../stores/agentStore';
import { useUIStore } from '../stores/uiStore';
import type { Agent, CreateAgentInput } from '../types/agent';
import { translateIfKey } from '../utils/agent-translation';
import { parseSortValue } from '../utils/agent-sorting';
import { useAgentFiltering } from '../hooks/useAgentFiltering';
import { getAgent as fetchAgentDetail } from '../api/agents';
import { logger } from '../utils/logger';

/**
 * AgentCard component for rendering individual agent cards
 */
interface AgentCardProps {
  agent: Agent;
  isSelected: boolean;
  isPinned: boolean;
  onSelect: (agent: Agent) => void;
  onToggleMenu: (agentId: string, event: React.MouseEvent) => void;
  openMenuId: string | null;
  onEdit: (agent: Agent) => void;
  onToggleShare: (agent: Agent) => void;
  onTogglePin: (agent: Agent) => void;
  onDelete: (agent: Agent) => void;
  t: TFunction;
}

const AgentCard: React.FC<AgentCardProps> = ({
  agent,
  isSelected,
  isPinned,
  onSelect,
  onToggleMenu,
  openMenuId,
  onEdit,
  onToggleShare,
  onTogglePin,
  onDelete,
  t,
}) => {
  const AgentIcon = (icons[agent.icon as keyof typeof icons] as LucideIcon) || Bot;

  return (
    <div
      className={`relative bg-surface-primary rounded-2xl transition-all cursor-pointer border ${
        isSelected ? 'border-blue-400' : 'border-border hover:border-border-strong'
      }`}
      onClick={() => onSelect(agent)}
    >
      <div className="p-4">
        <div className="flex items-start justify-between">
          <div className="flex items-center space-x-3 flex-1">
            <div
              className={`w-10 h-10 rounded-lg flex items-center justify-center ${
                isSelected ? 'bg-blue-100' : 'bg-surface-secondary'
              }`}
            >
              <AgentIcon
                className={`w-5 h-5 ${isSelected ? 'text-action-primary' : 'text-fg-secondary'}`}
              />
            </div>
            <div className="flex-1">
              <div className="flex items-center space-x-2">
                <h3 className="font-medium text-fg-default">{translateIfKey(agent.name, t)}</h3>
                {isPinned && <Pin className="w-3 h-3 text-fg-muted" />}
              </div>
              <p className="text-sm text-fg-muted mt-1 line-clamp-2">
                {translateIfKey(agent.description, t)}
              </p>
            </div>
          </div>

          <div className="relative ml-2">
            <button
              onClick={(e) => onToggleMenu(agent.agentId, e)}
              className="p-1.5 text-fg-disabled hover:text-fg-secondary hover:bg-surface-secondary rounded transition-colors"
            >
              <MoreHorizontal className="w-5 h-5" />
            </button>

            {/* Dropdown menu */}
            {openMenuId === agent.agentId && (
              <div className="absolute right-0 top-full mt-1 w-40 bg-surface-primary rounded-lg shadow-lg border border-border py-1 z-10">
                <button
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    onEdit(agent);
                  }}
                  className="w-full px-3 py-1.5 text-left text-sm text-fg-secondary hover:bg-surface-secondary flex items-center space-x-2"
                >
                  <Edit2 className="w-3 h-3" />
                  <span>{t('common.edit')}</span>
                </button>
                <button
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleShare(agent);
                  }}
                  className="w-full px-3 py-1.5 text-left text-sm text-fg-secondary hover:bg-surface-secondary flex items-center space-x-2"
                >
                  <Share2 className="w-3 h-3" />
                  <span>{agent.isShared ? t('agent.unshare') : t('agent.share')}</span>
                </button>
                <button
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    onTogglePin(agent);
                  }}
                  className="w-full px-3 py-1.5 text-left text-sm text-fg-secondary hover:bg-surface-secondary flex items-center space-x-2"
                >
                  {isPinned ? <PinOff className="w-3 h-3" /> : <Pin className="w-3 h-3" />}
                  <span>{isPinned ? t('agent.unpin') : t('agent.pin')}</span>
                </button>
                <button
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(agent);
                  }}
                  className="w-full px-3 py-1.5 text-left text-sm text-feedback-error hover:bg-feedback-error-bg flex items-center space-x-2"
                >
                  <Trash2 className="w-3 h-3" />
                  <span>{t('common.delete')}</span>
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

interface AgentSelectorModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAgentSelect: (agent: Agent | null) => void;
}

export const AgentSelectorModal: React.FC<AgentSelectorModalProps> = ({
  isOpen,
  onClose,
  onAgentSelect,
}) => {
  const { t } = useTranslation();
  const {
    agents,
    selectedAgent,
    selectAgent,
    createAgent,
    updateAgent,
    deleteAgent,
    toggleShare,
    refreshAgents,
    isLoading,
    error,
    pinnedAgentIds,
    pinAgent,
    unpinAgent,
    sortConfig,
    setSortConfig,
  } = useAgentStore();
  const { isMobileView } = useUIStore();

  const [mode, setMode] = useState<'list' | 'create' | 'edit'>('list');
  const [editingAgent, setEditingAgent] = useState<Agent | null>(null);
  const [deleteConfirmAgent, setDeleteConfirmAgent] = useState<Agent | null>(null);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  // Filtering, sorting, and pin grouping via custom hook
  const { filteredAgents, pinnedAgents, unpinnedAgents } = useAgentFiltering(
    agents,
    pinnedAgentIds,
    searchQuery,
    sortConfig,
    t
  );

  // Handle sort change
  const handleSortChange = (value: string) => {
    setSortConfig(parseSortValue(value));
  };

  // Shared callbacks for AgentCard (used by both pinned and unpinned sections)
  const handleEditAgent = useCallback(
    async (agent: Agent) => {
      setOpenMenuId(null);
      setEditingAgent(agent);
      setMode('edit');
      try {
        const fullAgent = await fetchAgentDetail(agent.agentId);
        setEditingAgent(fullAgent);
      } catch (err) {
        logger.warn('Failed to fetch agent detail:', err);
      }
    },
    [setOpenMenuId, setEditingAgent, setMode]
  );

  const handleToggleShareAgent = useCallback(
    async (agent: Agent) => {
      const wasShared = agent.isShared;
      try {
        await toggleShare(agent.agentId);
        toast.success(wasShared ? t('agent.unshareSuccess') : t('agent.shareSuccess'), {
          icon: '✅',
        });
      } catch (error) {
        logger.error('Failed to toggle share status:', error);
        toast.error(t('agent.shareError'));
      }
      setOpenMenuId(null);
    },
    [toggleShare, t, setOpenMenuId]
  );

  const handleDeleteConfirm = useCallback(
    (agent: Agent) => {
      setDeleteConfirmAgent(agent);
      setOpenMenuId(null);
    },
    [setDeleteConfirmAgent, setOpenMenuId]
  );

  // Initialize when modal opens
  useEffect(() => {
    if (isOpen) {
      // Refresh agents list from API
      refreshAgents();

      requestAnimationFrame(() => {
        setMode('list');
        setEditingAgent(null);
        setDeleteConfirmAgent(null);
        setOpenMenuId(null);
        setSearchQuery('');
      });
    }
  }, [isOpen, refreshAgents]);

  // Close on outside click
  useEffect(() => {
    const handleClickOutside = () => {
      setOpenMenuId(null);
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  // Select agent
  const handleAgentSelect = (agent: Agent) => {
    selectAgent(agent);
    onAgentSelect(agent);
    onClose();
  };

  // Create agent
  const handleCreateAgent = async (data: CreateAgentInput) => {
    const newAgent = await createAgent(data);
    setMode('list');
    selectAgent(newAgent);
    onAgentSelect(newAgent);
  };

  // Update agent
  const handleUpdateAgent = async (data: CreateAgentInput) => {
    if (!editingAgent) return;

    await updateAgent({
      agentId: editingAgent.agentId,
      ...data,
    });
    setMode('list');
    setEditingAgent(null);
  };

  // Delete agent
  const handleDeleteAgent = async (agent: Agent) => {
    await deleteAgent(agent.agentId);
    setDeleteConfirmAgent(null);
    setOpenMenuId(null);

    if (selectedAgent?.agentId === agent.agentId) {
      selectAgent(null);
      onAgentSelect(null);
    }
  };

  // 3-dot menu toggle
  const toggleMenu = (agentId: string, event: React.MouseEvent) => {
    event.stopPropagation();
    setOpenMenuId(openMenuId === agentId ? null : agentId);
  };

  const getModalTitle = () => {
    switch (mode) {
      case 'create':
        return t('agent.createAgent');
      case 'edit':
        return t('agent.editAgent');
      default:
        return t('agent.selectAgent');
    }
  };

  return (
    <>
      <Modal isOpen={isOpen} onClose={onClose} size="xl">
        <Modal.Header>
          <div className="flex items-center space-x-3">
            <Modal.Icon icon={Bot} />
            <Modal.Title>{getModalTitle()}</Modal.Title>
          </div>
          <Modal.CloseButton />
        </Modal.Header>

        {/* Form display mode */}
        {(mode === 'create' || mode === 'edit') && (
          <>
            <Modal.Content noPadding>
              <div className="h-full">
                {/* Error display */}
                {error && (
                  <div className="mx-6 mt-6 mb-4 p-4 bg-feedback-error-bg border border-feedback-error-border rounded-lg">
                    <p className="text-sm text-feedback-error">{error}</p>
                  </div>
                )}
                <AgentForm
                  agent={editingAgent || undefined}
                  onSubmit={mode === 'create' ? handleCreateAgent : handleUpdateAgent}
                  isLoading={isLoading}
                />
              </div>
            </Modal.Content>
            <Modal.Footer>
              <button
                type="button"
                onClick={() => {
                  setMode('list');
                  setEditingAgent(null);
                }}
                disabled={isLoading}
                className="px-6 py-3 text-sm md:text-base font-medium text-fg-secondary border border-border-strong rounded-lg hover:bg-surface-secondary disabled:opacity-50 disabled:cursor-not-allowed transition-colors min-h-[48px]"
              >
                {t('common.cancel')}
              </button>
              <button
                type="submit"
                form="agent-form"
                disabled={isLoading}
                className="inline-flex items-center justify-center space-x-2 px-6 py-3 text-sm md:text-base font-medium text-white bg-action-primary rounded-lg hover:bg-action-primary-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors min-h-[48px]"
              >
                <span>{isLoading ? t('common.saving') : t('common.save')}</span>
              </button>
            </Modal.Footer>
          </>
        )}

        {/* Agent list display mode */}
        {mode === 'list' && (
          <>
            <Modal.Content>
              <div className="h-[81vh] overflow-y-auto">
                {error && (
                  <div className="mb-6 p-4 bg-feedback-error-bg border border-feedback-error-border rounded-lg">
                    <p className="text-sm text-feedback-error">{error}</p>
                  </div>
                )}

                {/* Loading display */}
                {isLoading && <LoadingIndicator size="lg" spacing="lg" />}

                {/* Search bar and new creation button */}
                {!isLoading && agents.length > 0 && (
                  <div className="mb-6 flex items-center gap-4">
                    {/* Search bar (left side) */}
                    <div className="relative flex-1">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-fg-disabled" />
                      <input
                        type="text"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder={t('agent.searchPlaceholder')}
                        className="w-full pl-10 pr-10 py-2.5 border border-border-strong rounded-lg bg-surface-primary text-fg-default focus:outline-none focus:ring-2 focus:ring-border-focus focus:border-transparent text-sm"
                      />
                      {searchQuery && (
                        <button
                          type="button"
                          onClick={() => setSearchQuery('')}
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-fg-disabled hover:text-fg-secondary"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      )}
                    </div>

                    {/* New creation button (right side) - Mobile: icon only, Desktop: full text */}
                    <button
                      onClick={() => setMode('create')}
                      className={`inline-flex items-center text-white bg-action-primary rounded-xl hover:bg-action-primary-hover transition-colors shadow-sm ${
                        isMobileView ? 'p-2.5' : 'space-x-2 px-6 py-2.5'
                      }`}
                      title={isMobileView ? t('agent.createNewAgent') : undefined}
                    >
                      <Plus className="w-5 h-5" />
                      {!isMobileView && (
                        <span className="font-medium">{t('agent.createNewAgent')}</span>
                      )}
                    </button>
                  </div>
                )}

                {/* Agent list */}
                {!isLoading && agents.length === 0 ? (
                  <div className="text-center py-20">
                    <Bot className="w-16 h-16 text-fg-disabled mx-auto mb-6" />
                    <h3 className="text-lg font-medium text-fg-default mb-2">
                      {t('agent.noAgentsTitle')}
                    </h3>
                    <p className="text-fg-muted mb-6">{t('agent.noAgentsDescription')}</p>
                    <button
                      onClick={() => setMode('create')}
                      className="text-action-primary hover:text-action-primary font-medium"
                    >
                      {t('agent.createAgentButton')}
                    </button>
                  </div>
                ) : !isLoading && filteredAgents.length === 0 ? (
                  <div className="text-center py-20">
                    <Search className="w-16 h-16 text-fg-disabled mx-auto mb-6" />
                    <h3 className="text-lg font-medium text-fg-default mb-2">
                      {t('agent.noSearchResults')}
                    </h3>
                    <p className="text-fg-muted mb-6">{t('agent.noSearchResultsDescription')}</p>
                    <button
                      onClick={() => setSearchQuery('')}
                      className="text-action-primary hover:text-action-primary font-medium"
                    >
                      {t('agent.clearSearch')}
                    </button>
                  </div>
                ) : (
                  !isLoading && (
                    <>
                      {/* Pinned agents section */}
                      {pinnedAgents.length > 0 && (
                        <div className="mb-6">
                          <div className="flex items-center space-x-2 mb-3">
                            <Pin className="w-4 h-4 text-fg-muted" />
                            <h4 className="text-sm font-medium text-fg-muted">
                              {t('agent.pinnedAgents')}
                            </h4>
                          </div>
                          <div
                            className={`grid gap-4 ${isMobileView ? 'grid-cols-1' : 'grid-cols-1 md:grid-cols-2 lg:grid-cols-3'}`}
                          >
                            {pinnedAgents.map((agent) => (
                              <AgentCard
                                key={agent.agentId}
                                agent={agent}
                                isSelected={selectedAgent?.agentId === agent.agentId}
                                isPinned={true}
                                onSelect={handleAgentSelect}
                                onToggleMenu={toggleMenu}
                                openMenuId={openMenuId}
                                onEdit={handleEditAgent}
                                onToggleShare={handleToggleShareAgent}
                                onTogglePin={(agent) => {
                                  unpinAgent(agent.agentId);
                                  setOpenMenuId(null);
                                }}
                                onDelete={handleDeleteConfirm}
                                t={t}
                              />
                            ))}
                          </div>
                        </div>
                      )}

                      {/* All agents section with sort */}
                      <div>
                        <div className="flex items-center justify-between mb-3">
                          <h4 className="text-sm font-medium text-fg-muted">
                            {t('agent.allAgents')}
                          </h4>
                          <div className="flex items-center space-x-2">
                            <ArrowUpDown className="w-4 h-4 text-fg-muted" />
                            <select
                              value={`${sortConfig.field}-${sortConfig.order}`}
                              onChange={(e) => handleSortChange(e.target.value)}
                              className="text-sm border border-border-strong rounded-lg bg-surface-primary text-fg-default px-2 py-1 focus:outline-none focus:ring-2 focus:ring-border-focus"
                            >
                              <option value="createdAt-desc">{t('agent.sortNewest')}</option>
                              <option value="createdAt-asc">{t('agent.sortOldest')}</option>
                              <option value="name-asc">{t('agent.sortNameAZ')}</option>
                              <option value="name-desc">{t('agent.sortNameZA')}</option>
                              <option value="updatedAt-desc">
                                {t('agent.sortRecentlyUpdated')}
                              </option>
                            </select>
                          </div>
                        </div>
                        <div
                          className={`grid gap-4 ${isMobileView ? 'grid-cols-1' : 'grid-cols-1 md:grid-cols-2 lg:grid-cols-3'}`}
                        >
                          {unpinnedAgents.map((agent) => (
                            <AgentCard
                              key={agent.agentId}
                              agent={agent}
                              isSelected={selectedAgent?.agentId === agent.agentId}
                              isPinned={false}
                              onSelect={handleAgentSelect}
                              onToggleMenu={toggleMenu}
                              openMenuId={openMenuId}
                              onEdit={handleEditAgent}
                              onToggleShare={handleToggleShareAgent}
                              onTogglePin={(agent) => {
                                pinAgent(agent.agentId);
                                setOpenMenuId(null);
                              }}
                              onDelete={handleDeleteConfirm}
                              t={t}
                            />
                          ))}
                        </div>
                      </div>
                    </>
                  )
                )}
              </div>
            </Modal.Content>
          </>
        )}
      </Modal>

      {/* Delete confirmation modal */}
      {deleteConfirmAgent && (
        <ConfirmModal
          isOpen={!!deleteConfirmAgent}
          onClose={() => setDeleteConfirmAgent(null)}
          onConfirm={() => handleDeleteAgent(deleteConfirmAgent)}
          title={t('agent.deleteAgentConfirmTitle')}
          message={t('agent.deleteAgentConfirmMessage', {
            name: translateIfKey(deleteConfirmAgent.name, t),
          })}
          confirmText={t('common.delete')}
          cancelText={t('common.cancel')}
          variant="danger"
        />
      )}
    </>
  );
};
