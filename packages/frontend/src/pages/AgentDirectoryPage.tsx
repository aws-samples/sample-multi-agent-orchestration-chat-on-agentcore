/**
 * Agent Directory Page
 * Displays shared agents list and provides search functionality
 */

import { useEffect, useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { Bot, Users } from 'lucide-react';
import * as icons from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useSharedAgentStore } from '../stores/sharedAgentStore';
import { SharedAgentDetailModal } from '../components/SharedAgentDetailModal';
import { LoadingIndicator } from '../components/ui/LoadingIndicator';
import { PageHeader } from '../components/ui/PageHeader';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Alert } from '../components/ui/Alert';
import { EmptyState } from '../components/ui/EmptyState';
import { SearchSection } from '../components/ui/SearchSection';
import type { Agent } from '../types/agent';
import { translateIfKey } from '../utils/agent-translation';

/**
 * Main component for the Agent Directory page
 */
export function AgentDirectoryPage() {
  const { t } = useTranslation();
  const {
    sharedAgents,
    isLoading,
    isLoadingMore,
    error,
    hasMore,
    fetchSharedAgents,
    loadMoreAgents,
  } = useSharedAgentStore();

  const [searchParams, setSearchParams] = useSearchParams();
  const [localSearchQuery, setLocalSearchQuery] = useState('');

  // Search filtering
  const filteredAgents = useMemo(() => {
    if (!localSearchQuery.trim()) {
      return sharedAgents;
    }

    const query = localSearchQuery.toLowerCase();
    return sharedAgents.filter((agent) => {
      const name = translateIfKey(agent.name, t).toLowerCase();
      const description = translateIfKey(agent.description, t).toLowerCase();
      return name.includes(query) || description.includes(query);
    });
  }, [sharedAgents, localSearchQuery, t]);

  // Derive selected agent from URL parameter
  const selectedAgent = useMemo(() => {
    const agentParam = searchParams.get('agent');
    if (agentParam && sharedAgents.length > 0) {
      return sharedAgents.find((a) => `${a.createdBy}-${a.agentId}` === agentParam) || null;
    }
    return null;
  }, [searchParams, sharedAgents]);

  // Initial load
  useEffect(() => {
    fetchSharedAgents();
  }, [fetchSharedAgents]);

  // Execute DynamoDB search
  const handleSearch = () => {
    if (localSearchQuery.trim()) {
      fetchSharedAgents(localSearchQuery);
    }
  };

  // Clear search
  const handleClearSearch = () => {
    setLocalSearchQuery('');
  };

  // Agent card click
  const handleAgentClick = (agent: Agent) => {
    setSearchParams({ agent: `${agent.createdBy}-${agent.agentId}` });
  };

  // Close modal
  const handleCloseModal = () => {
    setSearchParams({});
  };

  return (
    <>
      <PageHeader icon={Users} title={t('navigation.searchAgents')} />

      <div className="flex-1 overflow-y-auto p-page">
        <p className="text-sm text-fg-secondary mb-section">{t('agentDirectory.description')}</p>

        {/* Search Section */}
        <SearchSection
          value={localSearchQuery}
          onChange={setLocalSearchQuery}
          onSearch={handleSearch}
          onClear={handleClearSearch}
          isSearching={isLoading}
          placeholder={t('agentDirectory.searchPlaceholder')}
          title={t('agentDirectory.searchTitle')}
          className="mb-section"
        />

        {/* Error */}
        {error && (
          <Alert variant="error" className="mb-section">
            {error}
          </Alert>
        )}

        {/* Loading */}
        {isLoading && (
          <div className="py-20">
            <LoadingIndicator message={t('agentDirectory.loading')} size="lg" />
          </div>
        )}

        {/* Empty state */}
        {!isLoading && filteredAgents.length === 0 && (
          <EmptyState
            icon={Bot}
            title={t('agentDirectory.noAgentsFound')}
            description={
              localSearchQuery
                ? t('agentDirectory.noAgentsDescription')
                : t('agentDirectory.noAgentsEmpty')
            }
            className="py-20"
          />
        )}

        {/* Agent grid */}
        {!isLoading && filteredAgents.length > 0 && (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {filteredAgents.map((agent) => {
                const AgentIcon = (icons[agent.icon as keyof typeof icons] as LucideIcon) || Bot;

                return (
                  <Card
                    key={`${agent.createdBy}-${agent.agentId}`}
                    variant="default"
                    padding="md"
                    interactive
                    onClick={() => handleAgentClick(agent)}
                  >
                    {/* Icon and name */}
                    <div className="flex items-start gap-3 mb-3">
                      <div className="w-10 h-10 rounded-btn bg-surface-secondary flex items-center justify-center flex-shrink-0">
                        <AgentIcon className="w-5 h-5 text-fg-secondary" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <h3 className="font-medium text-fg-default truncate">
                          {translateIfKey(agent.name, t)}
                        </h3>
                      </div>
                    </div>

                    {/* Description */}
                    <p className="text-sm text-fg-secondary line-clamp-2 mb-3">
                      {translateIfKey(agent.description, t)}
                    </p>

                    {/* Author */}
                    <div className="text-xs text-fg-muted">
                      {t('agentDirectory.createdBy')}:{' '}
                      <span className="font-medium">{agent.createdBy}</span>
                    </div>
                  </Card>
                );
              })}
            </div>

            {/* Load more */}
            {hasMore && (
              <div className="flex justify-center mt-8 pt-6 border-t border-border">
                <Button
                  variant="secondary"
                  size="lg"
                  onClick={loadMoreAgents}
                  loading={isLoadingMore}
                >
                  {isLoadingMore ? t('common.loading') : t('agentDirectory.loadMore')}
                </Button>
              </div>
            )}

            <p className="text-center text-xs text-fg-muted mt-4">
              {filteredAgents.length}
              {t('agentDirectory.itemsDisplayed')}{' '}
              {hasMore ? `/ ${t('agentDirectory.hasMore')}` : `/ ${t('agentDirectory.allLoaded')}`}
            </p>
          </>
        )}
      </div>

      <SharedAgentDetailModal agent={selectedAgent} onClose={handleCloseModal} />
    </>
  );
}
