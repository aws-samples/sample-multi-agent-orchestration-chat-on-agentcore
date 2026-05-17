/**
 * Memory Management Modal
 * Provides list and search functionality for saved memory records
 */

import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Search, Brain, AlertCircle, Loader2 } from 'lucide-react';
import { useMemoryStore } from '../stores/memoryStore';
import { type MemoryRecord } from '../api/memory';
import { Modal } from './ui/Modal/Modal';
import { logger } from '../utils/logger';

interface MemoryManagementModalProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * Memory record display component
 */
interface MemoryRecordItemProps {
  record: MemoryRecord;
}

function MemoryRecordItem({ record }: MemoryRecordItemProps) {
  const { t } = useTranslation();

  const truncatedContent =
    record.content.length > 100 ? record.content.slice(0, 100) + '...' : record.content;

  return (
    <div className="border border-border rounded-lg p-4 hover:bg-surface-secondary transition-colors">
      <div className="flex-1 min-w-0">
        <p className="text-sm text-fg-default leading-relaxed mb-2">{truncatedContent}</p>
        <div className="flex items-center gap-4 text-xs text-fg-muted">
          <span>
            {t('memory.created')}: {new Date(record.createdAt).toLocaleDateString()}
          </span>
          <span>
            {t('memory.updated')}: {new Date(record.updatedAt).toLocaleDateString()}
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * Memory management modal
 */
export function MemoryManagementModal({ isOpen, onClose }: MemoryManagementModalProps) {
  const { t } = useTranslation();
  const {
    records,
    isLoading,
    isLoadingMore,
    error,
    nextToken,
    loadMemoryRecords,
    loadMoreMemoryRecords,
    searchMemoryRecords,
    clearError,
  } = useMemoryStore();

  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<MemoryRecord[]>([]);
  const [isSearching, setIsSearching] = useState(false);

  // Load data when modal opens
  useEffect(() => {
    if (isOpen) {
      loadMemoryRecords();
    }
  }, [isOpen, loadMemoryRecords]);

  // Execute search
  const handleSearch = async () => {
    if (!searchQuery.trim()) {
      setSearchResults([]);
      return;
    }

    setIsSearching(true);
    try {
      const results = await searchMemoryRecords(searchQuery);
      setSearchResults(results);
    } catch (error) {
      logger.error('Search error:', error);
    } finally {
      setIsSearching(false);
    }
  };

  // Search on Enter key
  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSearch();
    }
  };

  // Clear search
  const handleClearSearch = () => {
    setSearchQuery('');
    setSearchResults([]);
  };

  // Records to display (search results when searching, all records otherwise)
  const displayRecords = searchQuery ? searchResults : records;

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="xl" className="max-w-4xl h-[70vh] flex flex-col">
      {/* Header */}
      <div className="border-b border-border px-6 py-4 flex-shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Brain className="w-5 h-5 text-fg-secondary" />
            <h2 className="text-lg font-semibold text-fg-default">{t('memory.savedMemories')}</h2>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-2 text-fg-disabled hover:text-fg-secondary hover:bg-surface-secondary transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <p className="text-sm text-fg-secondary mt-2">{t('memory.description')}</p>
      </div>

      {/* Search section */}
      <div className="px-6 py-4 border-b border-border flex-shrink-0">
        <div className="flex gap-3">
          <div className="flex-1 relative">
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
              <Search className="w-4 h-4 text-fg-disabled" />
            </div>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyPress={handleKeyPress}
              placeholder={t('memory.searchPlaceholder')}
              className="w-full pl-10 pr-4 py-2 border border-border-strong rounded-md bg-surface-primary text-fg-default focus:outline-none focus:ring-2 focus:ring-border-focus focus:border-transparent text-sm"
            />
            {searchQuery && (
              <button
                onClick={handleClearSearch}
                className="absolute inset-y-0 right-0 pr-3 flex items-center"
              >
                <X className="w-4 h-4 text-fg-disabled hover:text-fg-secondary" />
              </button>
            )}
          </div>
          <button
            onClick={handleSearch}
            disabled={isSearching || !searchQuery.trim()}
            className="px-4 py-2 bg-action-primary text-white text-sm font-medium rounded-md hover:bg-action-primary-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {isSearching ? <Loader2 className="w-4 h-4 animate-spin" /> : t('memory.searchButton')}
          </button>
        </div>
      </div>

      {/* Content area */}
      <div className="px-6 py-4 overflow-y-auto flex-1 min-h-0">
        {/* Error display */}
        {error && (
          <div className="mb-4 p-3 bg-feedback-error-bg border border-feedback-error-border rounded-lg flex items-start gap-2">
            <AlertCircle className="w-4 h-4 text-feedback-error mt-0.5 flex-shrink-0" />
            <div className="flex-1">
              <p className="text-sm text-feedback-error">{error}</p>
              <button
                onClick={clearError}
                className="text-sm text-feedback-error hover:text-feedback-error font-medium mt-1"
              >
                {t('common.close')}
              </button>
            </div>
          </div>
        )}

        {/* Loading */}
        {isLoading && (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-6 h-6 animate-spin text-fg-disabled" />
            <span className="ml-2 text-sm text-fg-secondary">{t('common.loading')}</span>
          </div>
        )}

        {/* Memory record list */}
        {!isLoading && (
          <>
            {searchQuery && (
              <div className="mb-4">
                <p className="text-sm text-fg-secondary">
                  {t('memory.searchResults')}: {searchQuery} (
                  {t('memory.searchResultsCount', { count: searchResults.length })})
                </p>
              </div>
            )}

            {displayRecords.length === 0 ? (
              <div className="text-center py-8">
                <Brain className="w-12 h-12 text-fg-disabled mx-auto mb-4" />
                <p className="text-sm text-fg-secondary mb-2">
                  {searchQuery
                    ? t('memory.noSearchResults')
                    : records.length === 0
                      ? t('memory.noMemoriesYet')
                      : t('memory.noMemories')}
                </p>
                {!searchQuery && records.length === 0 && (
                  <p className="text-xs text-fg-muted">{t('memory.autoAccumulate')}</p>
                )}
              </div>
            ) : (
              <div className="space-y-3">
                {displayRecords.map((record, index) => (
                  <MemoryRecordItem
                    key={record.recordId || `memory-${index}`}
                    record={record}
                  />
                ))}
                {!searchQuery && nextToken && (
                  <div className="flex justify-center pt-2">
                    <button
                      onClick={loadMoreMemoryRecords}
                      disabled={isLoadingMore}
                      className="px-4 py-2 text-sm font-medium text-fg-secondary bg-surface-primary border border-border-strong rounded-md hover:bg-surface-secondary disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
                    >
                      {isLoadingMore ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin" />
                          {t('common.loading')}
                        </>
                      ) : (
                        t('memory.loadMore')
                      )}
                    </button>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* Footer */}
      <div className="border-t border-border px-6 py-4 bg-surface-secondary flex-shrink-0">
        <div className="flex justify-between items-center">
          <p className="text-xs text-fg-muted">
            {t('memory.totalCount', { count: records.length })}
          </p>
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-fg-secondary bg-surface-primary border border-border-strong rounded-md hover:bg-surface-secondary transition-colors"
          >
            {t('common.close')}
          </button>
        </div>
      </div>
    </Modal>
  );
}
