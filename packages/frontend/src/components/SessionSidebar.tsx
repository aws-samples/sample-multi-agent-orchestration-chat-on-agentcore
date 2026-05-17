/**
 * Session Sidebar Component
 * Display and manage session list
 */

import { useEffect, useState, useRef, useCallback, memo } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Coffee,
  SquarePen,
  PanelRight,
  Wrench,
  Bot,
  User,
  LogOut,
  X,
  Settings,
  CalendarRange,
  Search,
  MoreHorizontal,
  Trash2,
} from 'lucide-react';
import { useAuthStore } from '../stores/authStore';
import { useSessionStore } from '../stores/sessionStore';
import { useUIStore } from '../stores/uiStore';
import { useSessionEventsSubscription } from '../hooks/useSessionEventsSubscription';
import { LoadingIndicator } from './ui/LoadingIndicator';
import { Tooltip } from './ui/Tooltip';
import { ConfirmModal } from './ui/Modal';
import { NavItem } from './ui/NavItem';
import type { SessionSummary } from '../api/sessions';
import { logger } from '../utils/logger';

/**
 * Session Item Component
 */
interface SessionItemProps {
  session: SessionSummary;
  isActive: boolean;
  isNew?: boolean;
  onDeleteRequest: (sessionId: string) => void;
}

const SessionItem = memo(function SessionItem({
  session,
  isActive,
  isNew = false,
  onDeleteRequest,
}: SessionItemProps) {
  const { t } = useTranslation();
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Check session type (default to 'user' for existing sessions without sessionType)
  const sessionType = session.sessionType ?? 'user';
  const isSubAgent = sessionType === 'subagent';
  const isEventTriggered = sessionType === 'event';

  // Close menu on outside click
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsMenuOpen(false);
      }
    };

    if (isMenuOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isMenuOpen]);

  const handleMenuClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsMenuOpen(!isMenuOpen);
  };

  const handleDeleteClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsMenuOpen(false);
    onDeleteRequest(session.sessionId);
  };

  return (
    <div className="relative group">
      <Link
        to={`/chat/${session.sessionId}`}
        className={`
          block w-full text-left p-2 pr-8 rounded-lg transition-all duration-200 no-underline
          ${isActive ? 'bg-surface-secondary' : 'hover:bg-surface-secondary'}
          ${isNew ? 'animate-subtle-fade-in' : ''}
        `}
      >
        <div className="flex items-center gap-2">
          <span
            className={`
            text-sm leading-tight truncate
            ${
              isSubAgent || isEventTriggered
                ? 'text-fg-muted'
                : isActive
                  ? 'text-fg-secondary'
                  : 'text-fg-secondary group-hover:text-fg-default'
            }
          `}
          >
            {isEventTriggered && <span className="text-xs">{'[Event] '}</span>}
            {isSubAgent && <span className="text-xs">{'[Sub] '}</span>}
            {session.title}
          </span>
        </div>
      </Link>

      {/* More options button - visible on hover */}
      <button
        onClick={handleMenuClick}
        className={`
          absolute right-1 top-1/2 -translate-y-1/2 p-1 rounded
          text-fg-disabled hover:text-fg-secondary hover:bg-border
          transition-opacity duration-200
          ${isMenuOpen ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}
        `}
        title={t('common.moreOptions')}
      >
        <MoreHorizontal className="w-4 h-4" />
      </button>

      {/* Dropdown menu */}
      {isMenuOpen && (
        <div
          ref={menuRef}
          className="absolute right-0 top-full mt-1 bg-surface-primary rounded-lg shadow-lg border border-border py-1 z-50 min-w-[120px]"
        >
          <button
            onClick={handleDeleteClick}
            className="w-full px-3 py-2 text-left text-sm text-feedback-error hover:bg-feedback-error-bg flex items-center gap-2"
          >
            <Trash2 className="w-4 h-4" />
            {t('common.delete')}
          </button>
        </div>
      )}
    </div>
  );
});

/**
 * Session Sidebar Component
 */
export function SessionSidebar() {
  const { t } = useTranslation();

  // Real-time session updates via AppSync Events
  useSessionEventsSubscription();

  const { user, logout } = useAuthStore();
  const {
    sessions,
    isLoadingSessions,
    sessionsError,
    hasLoadedOnce,
    activeSessionId,
    loadSessions,
    loadMoreSessions,
    deleteSession,
    clearActiveSession,
    hasMoreSessions,
    isLoadingMoreSessions,
  } = useSessionStore();
  const { isSidebarOpen, isMobileView, toggleSidebar } = useUIStore();

  // User dropdown state management
  const [isUserDropdownOpen, setIsUserDropdownOpen] = useState(false);
  const userDropdownRef = useRef<HTMLDivElement>(null);

  // Delete confirmation dialog state
  const [deleteTargetSessionId, setDeleteTargetSessionId] = useState<string | null>(null);

  // Detect new sessions
  const prevSessionIdsRef = useRef<Set<string>>(new Set());
  const [newSessionIds, setNewSessionIds] = useState<Set<string>>(new Set());

  // Infinite scroll refs
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Initial load
  useEffect(() => {
    if (user && !hasLoadedOnce && !isLoadingSessions) {
      logger.log('Starting initial session load');
      loadSessions();
    }
  }, [user, hasLoadedOnce, isLoadingSessions, loadSessions]);

  // Detect new sessions
  useEffect(() => {
    const currentIds = new Set(sessions.map((s) => s.sessionId));
    const prevIds = prevSessionIdsRef.current;

    // Detect newly added sessions
    const newIds = new Set<string>();
    currentIds.forEach((id) => {
      if (!prevIds.has(id)) {
        newIds.add(id);
      }
    });

    // Always update ref so next render compares against latest IDs
    prevSessionIdsRef.current = currentIds;

    if (newIds.size > 0) {
      // Execute setState asynchronously to avoid eslint error
      setTimeout(() => {
        setNewSessionIds(newIds);
      }, 0);
      // Clear after animation completes
      const timer = setTimeout(() => setNewSessionIds(new Set()), 300);
      return () => clearTimeout(timer);
    }
  }, [sessions]);

  // Infinite scroll: Intersection Observer for loading more sessions
  const handleIntersect = useCallback(
    (entries: IntersectionObserverEntry[]) => {
      const [entry] = entries;
      if (entry.isIntersecting && hasMoreSessions && !isLoadingMoreSessions) {
        logger.log('Infinite scroll triggered - loading more sessions');
        loadMoreSessions();
      }
    },
    [hasMoreSessions, isLoadingMoreSessions, loadMoreSessions]
  );

  useEffect(() => {
    const element = loadMoreRef.current;
    const container = scrollContainerRef.current;
    if (!element || !container) return;

    const observer = new IntersectionObserver(handleIntersect, {
      root: container, // Use the scroll container as the root
      rootMargin: '100px', // Start loading slightly before reaching the end
      threshold: 0.1,
    });

    observer.observe(element);

    return () => {
      observer.disconnect();
    };
  }, [handleIntersect]);

  // Start new chat
  const handleNewChat = (e: React.MouseEvent) => {
    // Don't change state when Cmd/Ctrl+click or middle-click (opens in new tab)
    if (e.metaKey || e.ctrlKey || e.button === 1) {
      return;
    }
    logger.log('Starting new chat');
    clearActiveSession();
  };

  // Toggle sidebar
  const handleToggleSidebar = () => {
    toggleSidebar();
  };

  // Logout handler
  const handleLogout = async () => {
    try {
      await logout();
    } catch (error) {
      logger.error('Logout error:', error);
    }
  };

  // Toggle user dropdown
  const toggleUserDropdown = () => {
    setIsUserDropdownOpen(!isUserDropdownOpen);
  };

  // Close dropdown on outside click
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (userDropdownRef.current && !userDropdownRef.current.contains(event.target as Node)) {
        setIsUserDropdownOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  // Handle delete request - opens confirmation dialog
  const handleDeleteRequest = (sessionId: string) => {
    setDeleteTargetSessionId(sessionId);
  };

  // Handle delete confirmation
  const handleDeleteConfirm = () => {
    if (!deleteTargetSessionId) return;

    // Close dialog immediately (optimistic UI)
    const sessionIdToDelete = deleteTargetSessionId;
    setDeleteTargetSessionId(null);

    // Execute deletion in background (no await needed with optimistic UI)
    deleteSession(sessionIdToDelete);
  };

  // Handle delete cancel
  const handleDeleteCancel = () => {
    setDeleteTargetSessionId(null);
  };

  // Get session title for delete confirmation
  const deleteTargetSession = deleteTargetSessionId
    ? sessions.find((s) => s.sessionId === deleteTargetSessionId)
    : null;

  if (!user) {
    return null;
  }

  // Always expanded on mobile (overlay form, so expanded display internally)
  // Follow current state on narrow desktop (auto-collapse recommended but can be manually opened)
  // Follow current state on wide desktop
  const shouldShowExpanded = isMobileView || isSidebarOpen;

  return (
    <div
      className={`h-full bg-surface-primary border-r border-border flex flex-col ${shouldShowExpanded ? 'w-80' : 'w-16'}`}
    >
      {/* Header */}
      <div
        className={`p-4 ${shouldShowExpanded ? 'border-b border-border' : ''} bg-surface-primary`}
      >
        <div
          className={`flex items-center mb-3 ${shouldShowExpanded ? 'justify-between' : 'justify-center'}`}
        >
          {shouldShowExpanded ? (
            <>
              <Link
                to="/"
                className="flex items-center gap-2 rounded-lg p-2 pb-1 pt-1 transition-colors group no-underline"
                title="Return to home page"
              >
                <Coffee className="w-5 h-5 text-fg-secondary group-hover:text-amber-600 transition-colors" />
                <span className="text-lg font-semibold text-fg-default group-hover:text-amber-700 transition-colors">
                  {t('app.name')}
                </span>
              </Link>

              {/* × button on mobile, PanelRight button on desktop */}
              <button
                onClick={handleToggleSidebar}
                className="p-2 text-fg-secondary hover:text-fg-default hover:bg-surface-secondary rounded-lg transition-colors"
                title={isMobileView ? 'Close sidebar' : 'Close sidebar'}
              >
                {isMobileView ? <X className="w-5 h-5" /> : <PanelRight className="w-5 h-5" />}
              </button>
            </>
          ) : (
            <button
              onClick={handleToggleSidebar}
              className="p-2 text-fg-secondary hover:text-fg-default hover:bg-surface-secondary rounded-lg transition-colors group"
              title="Open sidebar"
            >
              <Coffee className="w-5 h-5 text-amber-600 group-hover:hidden" />
              <PanelRight className="w-5 h-5 hidden group-hover:block" />
            </button>
          )}
        </div>

        <div className={`space-y-2 ${!shouldShowExpanded ? 'flex flex-col items-center' : ''}`}>
          <NavItem
            to="/chat"
            icon={SquarePen}
            label={t('navigation.newChat')}
            collapsed={!shouldShowExpanded}
            onClick={handleNewChat}
          />
          <NavItem
            to="/chat/search"
            icon={Search}
            label={t('navigation.searchChat')}
            collapsed={!shouldShowExpanded}
          />
          <NavItem
            to="/agents"
            icon={Bot}
            label={t('navigation.searchAgents')}
            collapsed={!shouldShowExpanded}
          />
          <NavItem
            to="/tools"
            icon={Wrench}
            label={t('navigation.searchTools')}
            collapsed={!shouldShowExpanded}
          />
          <NavItem
            to="/events"
            icon={CalendarRange}
            label={t('navigation.events')}
            collapsed={!shouldShowExpanded}
          />
        </div>
      </div>

      {/* Session list - Display only when expanded */}
      {shouldShowExpanded && (
        <div ref={scrollContainerRef} className="flex-1 overflow-y-auto">
          {sessionsError && (
            <div className="p-4">
              <div className="bg-feedback-error-bg border border-feedback-error-border text-feedback-error px-3 py-2 rounded-lg text-sm">
                <div className="flex items-center gap-2">
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                    <path
                      fillRule="evenodd"
                      d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z"
                      clipRule="evenodd"
                    />
                  </svg>
                  <span>{sessionsError}</span>
                </div>
              </div>
            </div>
          )}

          {isLoadingSessions && sessions.length === 0 && (
            <div className="p-4">
              <LoadingIndicator message={t('chat.loadingSessions')} spacing="none" />
            </div>
          )}

          {!isLoadingSessions && sessions.length === 0 && !sessionsError && (
            <div className="p-4 text-center text-fg-muted">
              <svg
                className="w-12 h-12 mx-auto mb-3 text-fg-disabled"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
                />
              </svg>
              <p className="text-sm">{t('chat.noConversations')}</p>
              <p className="text-xs text-fg-disabled mt-1">{t('chat.startNewChat')}</p>
            </div>
          )}

          {sessions.length > 0 && (
            <div className="px-4 py-2 space-y-2">
              {sessions.map((session) => (
                <SessionItem
                  key={session.sessionId}
                  session={session}
                  isActive={session.sessionId === activeSessionId}
                  isNew={newSessionIds.has(session.sessionId)}
                  onDeleteRequest={handleDeleteRequest}
                />
              ))}

              {/* Infinite scroll sentinel element */}
              {hasMoreSessions && (
                <div ref={loadMoreRef} className="py-4 flex items-center justify-center">
                  {isLoadingMoreSessions && <LoadingIndicator message="" spacing="none" />}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* User info - Bottom of sidebar */}
      <div
        className={`mt-auto p-4 border-t border-border ${!shouldShowExpanded ? 'flex justify-center' : ''}`}
      >
        <div className="relative" ref={userDropdownRef}>
          <Tooltip
            content={t('navigation.userMenu')}
            position="right"
            disabled={shouldShowExpanded}
          >
            <button
              onClick={toggleUserDropdown}
              className={`flex items-center gap-2 p-2 rounded-lg hover:bg-surface-secondary transition-colors ${
                shouldShowExpanded ? 'w-full text-left' : 'w-auto'
              }`}
            >
              <div className="w-8 h-8 bg-surface-secondary rounded-full flex items-center justify-center">
                <User className="w-4 h-4 text-fg-secondary" />
              </div>
              {shouldShowExpanded && (
                <span className="text-sm font-medium text-fg-default truncate">
                  {user.username}
                </span>
              )}
            </button>
          </Tooltip>

          {/* Dropdown menu */}
          {isUserDropdownOpen && (
            <div
              className={`absolute bg-surface-primary rounded-2xl shadow-lg border border-border py-2 z-50 ${
                shouldShowExpanded
                  ? 'bottom-full left-0 right-0 mb-2'
                  : 'bottom-full left-0 mb-2 w-48'
              }`}
            >
              {/* User info - Display only when expanded */}
              {shouldShowExpanded && (
                <div className="px-4 py-2 border-b border-border">
                  <p className="text-sm font-medium text-fg-default">{user.username}</p>
                  <p className="text-xs text-fg-muted">{t('auth.authenticated')}</p>
                </div>
              )}

              {/* Also show username when collapsed */}
              {!shouldShowExpanded && (
                <div className="px-4 py-2 border-b border-border">
                  <p className="text-sm font-medium text-fg-default">{user.username}</p>
                  <p className="text-xs text-fg-muted">{t('auth.authenticated')}</p>
                </div>
              )}

              {/* Settings */}
              <Link
                to="/settings"
                onClick={() => setIsUserDropdownOpen(false)}
                className="w-full px-4 py-2 text-left text-sm text-fg-secondary hover:bg-surface-secondary flex items-center gap-2 no-underline"
              >
                <Settings className="w-4 h-4" />
                {t('navigation.settings')}
              </Link>

              {/* Logout */}
              <button
                onClick={handleLogout}
                className="w-full px-4 py-2 text-left text-sm text-fg-secondary hover:bg-surface-secondary flex items-center gap-2"
              >
                <LogOut className="w-4 h-4" />
                {t('auth.signOut')}
              </button>
            </div>
          )}
        </div>
      </div>
      {/* Delete confirmation modal */}
      <ConfirmModal
        isOpen={!!deleteTargetSessionId}
        onClose={handleDeleteCancel}
        onConfirm={handleDeleteConfirm}
        title={t('chat.deleteSession')}
        message={t('chat.deleteSessionConfirm', { title: deleteTargetSession?.title || '' })}
        confirmText={t('common.delete')}
        cancelText={t('common.cancel')}
        variant="danger"
      />
    </div>
  );
}
