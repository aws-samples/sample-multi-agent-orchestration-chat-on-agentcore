/**
 * Tools List Page
 * Provides tool list and search functionality for AgentCore Gateway
 */

import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Wrench, RefreshCw } from 'lucide-react';
import { useAuthStore } from '../stores/authStore';
import { useToolStore } from '../stores/toolStore';
import { LoadingIndicator } from '../components/ui/LoadingIndicator';
import { PageHeader } from '../components/ui/PageHeader';
import { IconButton } from '../components/ui/Button';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Alert } from '../components/ui/Alert';
import { EmptyState } from '../components/ui/EmptyState';
import { SearchSection } from '../components/ui/SearchSection';
import { getToolIcon } from '../utils/toolIcons';
import type { MCPTool } from '../api/tools';

/**
 * Tool item component
 */
interface ToolItemProps {
  tool: MCPTool;
}

function ToolItem({ tool }: ToolItemProps) {
  const { t } = useTranslation();
  const [isExpanded, setIsExpanded] = useState(false);

  const hasLongDescription = tool.description ? tool.description.length > 200 : false;
  const hasParameters =
    tool.inputSchema.properties && Object.keys(tool.inputSchema.properties).length > 0;
  const isExpandable = hasParameters || hasLongDescription;

  const renderParameters = () => {
    if (!tool.inputSchema.properties) return null;

    const properties = tool.inputSchema.properties;
    const required = tool.inputSchema.required || [];

    return (
      <div className="mt-3 pt-3 border-t border-border">
        <h4 className="text-xs font-medium text-fg-secondary mb-2">{t('tool.parameters')}:</h4>
        <div className="space-y-2">
          {Object.entries(properties).map(([paramName, paramInfo]) => {
            const info = paramInfo as Record<string, unknown>;
            const typeString = typeof info.type === 'string' ? info.type : 'unknown';
            const description = typeof info.description === 'string' ? info.description : null;

            return (
              <div key={paramName} className="bg-surface-secondary px-3 py-2 rounded text-xs">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-action-primary">{paramName}</span>
                  <span className="text-fg-muted">({typeString})</span>
                  {required.includes(paramName) && (
                    <span className="text-feedback-error text-xs">*{t('tool.required')}</span>
                  )}
                </div>
                {description && <p className="text-fg-secondary mt-1">{description}</p>}
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <Card variant="default" padding="md">
      <div
        className={`flex items-start gap-3 ${isExpandable ? 'cursor-pointer' : ''}`}
        role={isExpandable ? 'button' : undefined}
        tabIndex={isExpandable ? 0 : undefined}
        onClick={() => isExpandable && setIsExpanded(!isExpanded)}
        onKeyDown={(e) => {
          if (isExpandable && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            setIsExpanded(!isExpanded);
          }
        }}
      >
        <div className="flex-shrink-0 w-8 h-8 bg-surface-secondary rounded-btn flex items-center justify-center text-fg-secondary">
          {getToolIcon(tool.name)}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-fg-default truncate">{tool.name}</h3>

            {isExpandable && (
              <span className="flex-shrink-0 p-1 text-fg-disabled">
                <svg
                  className={`w-4 h-4 transform transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                  fill="currentColor"
                  viewBox="0 0 20 20"
                >
                  <path
                    fillRule="evenodd"
                    d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z"
                    clipRule="evenodd"
                  />
                </svg>
              </span>
            )}
          </div>

          {tool.description && (
            <p
              className={`text-fg-secondary text-sm mt-1 leading-relaxed ${!isExpanded ? 'line-clamp-3' : ''}`}
            >
              {tool.description}
            </p>
          )}

          {isExpanded && renderParameters()}
        </div>
      </div>
    </Card>
  );
}

/**
 * Main component for the tools list page
 */
export function ToolsPage() {
  const { t } = useTranslation();
  const { user } = useAuthStore();
  const {
    tools,
    isLoading,
    error,
    nextCursor,
    searchQuery,
    searchResults,
    isSearching,
    searchError,
    loadTools,
    loadMoreTools,
    searchToolsWithQuery,
    clearSearch,
    setSearchQuery,
    clearError,
  } = useToolStore();

  const [localSearchQuery, setLocalSearchQuery] = useState('');

  useEffect(() => {
    if (user) {
      loadTools();
    }
  }, [user, loadTools]);

  const handleSearch = async () => {
    if (!user) return;
    if (!localSearchQuery.trim()) {
      clearSearch();
      return;
    }
    await searchToolsWithQuery(localSearchQuery.trim());
  };

  const handleClearSearch = () => {
    setLocalSearchQuery('');
    setSearchQuery('');
    clearSearch();
  };

  const handleRefresh = () => {
    if (user) {
      clearError();
      loadTools();
    }
  };

  const handleLoadMore = async () => {
    if (user) {
      await loadMoreTools();
    }
  };

  const displayTools = searchQuery ? searchResults : tools;
  const currentLoading = searchQuery ? isSearching : isLoading;
  const currentError = searchQuery ? searchError : error;

  if (!user) {
    return null;
  }

  return (
    <>
      <PageHeader
        icon={Wrench}
        title={t('tool.availableTools')}
        actions={
          <IconButton
            icon={RefreshCw}
            label={t('tool.refresh')}
            variant="subtle"
            disabled={currentLoading}
            className={currentLoading ? '[&>svg]:animate-spin' : ''}
            onClick={handleRefresh}
          />
        }
      />

      <div className="flex-1 overflow-y-auto p-page">
        {/* Search Section */}
        <SearchSection
          value={localSearchQuery}
          onChange={setLocalSearchQuery}
          onSearch={handleSearch}
          onClear={handleClearSearch}
          isSearching={isSearching}
          placeholder={t('tool.searchPlaceholder')}
          title={t('tool.searchTools')}
          activeQuery={searchQuery || undefined}
          className="mb-section"
        />

        {/* Error */}
        {currentError && (
          <Alert
            variant="error"
            title={t('common.error')}
            onDismiss={() => clearError()}
            className="mb-section"
          >
            {currentError}
          </Alert>
        )}

        {/* Tool list */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-lg font-medium text-fg-default">
              {searchQuery ? t('tool.searchResults') : t('tool.availableTools')}
              <span className="ml-2 text-fg-muted font-normal text-sm">
                (
                {currentLoading
                  ? t('common.loading')
                  : `${displayTools.length}${t('tool.displayedCount')}`}
                )
              </span>
            </h2>
          </div>

          {!searchQuery && (
            <p className="text-xs text-fg-muted mb-4">{t('tool.toolsPageDescription')}</p>
          )}

          {currentLoading && displayTools.length === 0 && (
            <LoadingIndicator
              message={searchQuery ? t('tool.searching') : t('tool.loadingTools')}
              spacing="lg"
            />
          )}

          {!currentLoading && displayTools.length === 0 && !currentError && (
            <EmptyState
              icon={Wrench}
              title={searchQuery ? t('tool.noSearchResults') : t('tool.noToolsFound')}
              description={
                searchQuery ? t('tool.tryDifferentKeyword') : t('tool.noToolsRegistered')
              }
            />
          )}

          {displayTools.length > 0 && (
            <div className="space-y-4">
              {displayTools.map((tool, index) => (
                <ToolItem key={`${tool.name}-${index}`} tool={tool} />
              ))}
            </div>
          )}

          {/* Pagination */}
          {!searchQuery && nextCursor && displayTools.length > 0 && (
            <div className="flex justify-center mt-8 pt-6 border-t border-border">
              <Button variant="secondary" size="lg" onClick={handleLoadMore} loading={isLoading}>
                {isLoading ? t('common.loading') : t('tool.loadMore')}
              </Button>
            </div>
          )}

          {!searchQuery && displayTools.length > 0 && (
            <div className="mt-4 text-center">
              <p className="text-xs text-fg-muted">
                {displayTools.length}
                {t('tool.displayedCount')}
                {nextCursor ? ` / ${t('tool.hasMore')}` : ` / ${t('tool.allLoaded')}`}
              </p>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
