/**
 * Chat Search Page
 * Search and filter past conversation sessions
 */

import { useState, useMemo, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Search, Trash2 } from 'lucide-react';
import { PageHeader } from '../components/ui/PageHeader';
import { LoadingIndicator } from '../components/ui/LoadingIndicator';
import { ConfirmModal } from '../components/ui/Modal';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { useSessionStore } from '../stores/sessionStore';

/**
 * Search Chat Page Main Component
 */
export function SearchChatPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const {
    sessions,
    isLoadingSessions,
    isLoadingMoreSessions,
    loadAllSessions,
    deleteMultipleSessions,
  } = useSessionStore();

  const [searchQuery, setSearchQuery] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  // Selection state
  const [selectedSessionIds, setSelectedSessionIds] = useState<Set<string>>(new Set());
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  // Load all sessions on mount
  useEffect(() => {
    loadAllSessions();
  }, [loadAllSessions]);

  const isLoading = isLoadingSessions || isLoadingMoreSessions;

  // Filter sessions
  const filteredSessions = useMemo(() => {
    return sessions.filter((session) => {
      if (searchQuery && !session.title.toLowerCase().includes(searchQuery.toLowerCase())) {
        return false;
      }
      const sessionDate = new Date(session.updatedAt);
      if (startDate && sessionDate < new Date(startDate)) {
        return false;
      }
      if (endDate) {
        const endDateTime = new Date(endDate);
        endDateTime.setHours(23, 59, 59, 999);
        if (sessionDate > endDateTime) {
          return false;
        }
      }
      return true;
    });
  }, [sessions, searchQuery, startDate, endDate]);

  const allFilteredSelected =
    filteredSessions.length > 0 &&
    filteredSessions.every((s) => selectedSessionIds.has(s.sessionId));

  const toggleSelection = useCallback((sessionId: string, event: React.MouseEvent) => {
    event.stopPropagation();
    setSelectedSessionIds((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(sessionId)) {
        newSet.delete(sessionId);
      } else {
        newSet.add(sessionId);
      }
      return newSet;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    if (allFilteredSelected) {
      setSelectedSessionIds((prev) => {
        const newSet = new Set(prev);
        filteredSessions.forEach((s) => newSet.delete(s.sessionId));
        return newSet;
      });
    } else {
      setSelectedSessionIds((prev) => {
        const newSet = new Set(prev);
        filteredSessions.forEach((s) => newSet.add(s.sessionId));
        return newSet;
      });
    }
  }, [allFilteredSelected, filteredSessions]);

  const clearSelection = useCallback(() => {
    setSelectedSessionIds(new Set());
  }, []);

  const handleBulkDelete = useCallback(() => {
    setShowDeleteConfirm(true);
  }, []);

  const confirmBulkDelete = useCallback(() => {
    const idsToDelete = Array.from(selectedSessionIds);
    setShowDeleteConfirm(false);
    setSelectedSessionIds(new Set());
    deleteMultipleSessions(idsToDelete);
  }, [selectedSessionIds, deleteMultipleSessions]);

  const handleSessionClick = (sessionId: string) => {
    navigate(`/chat/${sessionId}`);
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleString();
  };

  const selectedCount = selectedSessionIds.size;

  return (
    <>
      <PageHeader icon={Search} title={t('navigation.searchChat')} />

      <div className="flex-1 overflow-y-auto p-page">
        <div className="max-w-6xl mx-auto">
          {/* Search and Filter Section */}
          <div className="mb-section space-y-4">
            <div>
              <Input
                type="text"
                placeholder={t('chat.searchPlaceholder')}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                inputSize="lg"
              />
              <p className="text-xs text-fg-disabled mt-1">{t('chat.searchNote')}</p>
            </div>

            {/* Date Range Filter */}
            <div className="flex items-center gap-4">
              <span className="text-sm text-fg-secondary whitespace-nowrap">
                {t('chat.searchDateRange')}:
              </span>
              <Input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                inputSize="sm"
                placeholder={t('chat.searchDateStart')}
              />
              <span className="text-fg-disabled">-</span>
              <Input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                inputSize="sm"
                placeholder={t('chat.searchDateEnd')}
              />
            </div>
          </div>

          {/* Results Count and Actions */}
          <div className="mb-4 flex items-center justify-between">
            <p className="text-sm text-fg-secondary">
              {t('chat.searchResults')}:{' '}
              {isLoading ? (
                <span className="text-fg-disabled">
                  {t('chat.loadingSessions')} ({sessions.length}...)
                </span>
              ) : (
                t('chat.searchResultsCount', { count: filteredSessions.length })
              )}
            </p>

            {selectedCount > 0 && (
              <div className="flex items-center gap-3">
                <span className="text-sm text-fg-secondary">
                  {t('chat.selectedCount', { count: selectedCount })}
                </span>
                <button
                  onClick={clearSelection}
                  className="text-sm text-fg-muted hover:text-fg-default transition-colors"
                >
                  {t('chat.clearSelection')}
                </button>
                <Button variant="danger" size="sm" leftIcon={Trash2} onClick={handleBulkDelete}>
                  {t('chat.bulkDelete')}
                </Button>
              </div>
            )}
          </div>

          {/* Loading State */}
          {isLoading && sessions.length === 0 && (
            <div className="py-12">
              <LoadingIndicator message={t('chat.loadingSessions')} />
            </div>
          )}

          {/* Sessions Table */}
          {!isLoading && filteredSessions.length === 0 ? (
            <div className="text-center py-12 text-fg-muted">
              <p>{t('chat.searchNoResults')}</p>
            </div>
          ) : filteredSessions.length > 0 ? (
            <div className="border border-border rounded-card overflow-hidden">
              <table className="w-full">
                <thead className="bg-surface-secondary border-b border-border">
                  <tr>
                    <th className="px-4 py-3 text-left w-12">
                      <input
                        type="checkbox"
                        checked={allFilteredSelected}
                        onChange={toggleSelectAll}
                        className="w-4 h-4 text-action-primary border-border-strong rounded focus:ring-border-focus cursor-pointer"
                        title={allFilteredSelected ? t('chat.deselectAll') : t('chat.selectAll')}
                      />
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-fg-muted uppercase tracking-wider">
                      {t('chat.sessionName')}
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-fg-muted uppercase tracking-wider">
                      {t('chat.updatedAt')}
                    </th>
                  </tr>
                </thead>
                <tbody className="bg-surface-primary divide-y divide-border">
                  {filteredSessions.map((session) => {
                    const isSelected = selectedSessionIds.has(session.sessionId);
                    return (
                      <tr
                        key={session.sessionId}
                        onClick={() => handleSessionClick(session.sessionId)}
                        className={`hover:bg-surface-secondary cursor-pointer transition-colors ${isSelected ? 'bg-feedback-info-bg' : ''}`}
                      >
                        <td
                          className="px-4 py-4 cursor-pointer"
                          onClick={(e) => toggleSelection(session.sessionId, e)}
                        >
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => {}}
                            className="w-4 h-4 text-action-primary border-border-strong rounded focus:ring-border-focus pointer-events-none"
                          />
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          <div className="text-sm text-fg-default">{session.title}</div>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          <div className="text-sm text-fg-muted">
                            {formatDate(session.updatedAt)}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>

              {isLoading && (
                <div className="py-4 border-t border-border bg-surface-secondary">
                  <LoadingIndicator message="" spacing="none" />
                </div>
              )}
            </div>
          ) : null}
        </div>
      </div>

      <ConfirmModal
        isOpen={showDeleteConfirm}
        onClose={() => setShowDeleteConfirm(false)}
        onConfirm={confirmBulkDelete}
        title={t('chat.bulkDelete')}
        message={t('chat.bulkDeleteConfirm', { count: selectedCount })}
        confirmText={t('common.delete')}
        cancelText={t('common.cancel')}
        variant="danger"
      />
    </>
  );
}
