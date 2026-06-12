/**
 * Main Layout Component
 * Provides sidebar and common layout
 */

import { useEffect, useState } from 'react';
import { Outlet, useLocation, Link, useSearchParams } from 'react-router-dom';
import { Menu, Bot, SquarePen } from 'lucide-react';
import * as icons from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { SessionSidebar } from '../components/SessionSidebar';
import { useUIStore } from '../stores/uiStore';
import { useSelectedAgent, useAgentStore } from '../stores/agentStore';
import { AgentSelectorModal } from '../components/AgentSelectorModal';
import type { Agent } from '../types/agent';
import { translateIfKey } from '../utils/agent-translation';
import { getPageTitleKey } from '../config/routes';
import { useSessionStore } from '../stores/sessionStore';
import { useSwipeGesture } from '../hooks/useSwipeGesture';
import { useSidebarShortcut } from '../hooks/useSidebarShortcut';
import { useNewChatShortcut } from '../hooks/useNewChatShortcut';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useShortcutsHelp } from '../hooks/useShortcutsHelp';
import { ShortcutsModal } from '../components/ShortcutsModal';

export function MainLayout() {
  const {
    isSidebarOpen,
    isMobileView,
    mobileHeaderAction,
    setSidebarOpen,
    setMobileView,
    setNarrowDesktop,
  } = useUIStore();
  const location = useLocation();
  const { t } = useTranslation();
  const selectedAgent = useSelectedAgent();
  const isAgentLoading = useAgentStore((state) => state.isLoading);
  const [isAgentModalOpen, setIsAgentModalOpen] = useState(false);
  const { clearActiveSession } = useSessionStore();

  // Check if current page is a chat page (not /chat/search)
  const isChatRoute = (path: string) => {
    return path === '/chat' || (path.startsWith('/chat/') && path !== '/chat/search');
  };

  // Get page title
  const getPageTitle = () => {
    const path = location.pathname;

    // Return agent name for chat page
    if (isChatRoute(path)) {
      return selectedAgent ? translateIfKey(selectedAgent.name, t) : '汎用アシスタント';
    }

    // Get translation key from route config
    const titleKey = getPageTitleKey(path);
    return titleKey ? t(titleKey) : '';
  };

  // Get page icon
  const getPageIcon = () => {
    const path = location.pathname;

    // Return agent icon for chat page
    if (isChatRoute(path) && selectedAgent?.icon) {
      const AgentIcon = (icons[selectedAgent.icon as keyof typeof icons] as LucideIcon) || Bot;
      return <AgentIcon className="w-5 h-5 text-fg-secondary flex-shrink-0" />;
    }

    return null;
  };

  // Handle title click
  const handleTitleClick = () => {
    if (isChatRoute(location.pathname)) {
      setIsAgentModalOpen(true);
    }
  };

  const [, setSearchParams] = useSearchParams();

  // Handle agent selection from mobile header modal — also update URL
  const handleAgentSelect = (agent: Agent | null) => {
    if (agent) {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set('agent', agent.agentId);
          return next;
        },
        { replace: false }
      );
    }
  };

  // Handle new chat creation
  const handleNewChat = (e: React.MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.button === 1) {
      return;
    }
    clearActiveSession();
  };

  const pageTitle = getPageTitle();
  const pageIcon = getPageIcon();
  const isChatPage = isChatRoute(location.pathname);
  const showSkeleton = isChatPage && isAgentLoading;

  // Responsive design: 3 breakpoints
  // - < 768px: Mobile (completely hidden, hamburger menu only)
  // - 768px - 1024px: Narrow desktop (auto-collapse)
  // - > 1024px: Wide desktop (follows user settings)
  useEffect(() => {
    const mobileQuery = window.matchMedia('(max-width: 767px)');
    const narrowDesktopQuery = window.matchMedia('(min-width: 768px) and (max-width: 1023px)');

    const handleResize = () => {
      const isMobile = mobileQuery.matches;
      const isNarrow = narrowDesktopQuery.matches;

      setMobileView(isMobile);
      setNarrowDesktop(isNarrow);

      if (isMobile) {
        // Mobile: Close sidebar (overlay style)
        setSidebarOpen(false);
      } else if (isNarrow) {
        // Narrow desktop: Auto collapse
        setSidebarOpen(false);
      }
      // Wide desktop (> 1024px): Do nothing (preserve user settings)
    };

    // Initial check
    handleResize();

    // Register listener
    mobileQuery.addEventListener('change', handleResize);
    narrowDesktopQuery.addEventListener('change', handleResize);

    return () => {
      mobileQuery.removeEventListener('change', handleResize);
      narrowDesktopQuery.removeEventListener('change', handleResize);
    };
  }, [setSidebarOpen, setMobileView, setNarrowDesktop]);

  // Sync the browser tab title with the active session's title
  useDocumentTitle();

  // Cmd+B / Ctrl+B shortcut to toggle sidebar (desktop only)
  useSidebarShortcut();

  // Cmd+Shift+O / Ctrl+Shift+O shortcut to start a new chat (matches ChatGPT convention)
  useNewChatShortcut();

  // Cmd+/ / Ctrl+/ shortcut to open the keyboard shortcuts help modal
  const { isOpen: isShortcutsHelpOpen, close: closeShortcutsHelp } = useShortcutsHelp();

  // Swipe gesture support on mobile
  useSwipeGesture({
    onSwipeRight: () => {
      if (isMobileView && !isSidebarOpen) {
        setSidebarOpen(true);
      }
    },
    onSwipeLeft: () => {
      if (isMobileView && isSidebarOpen) {
        setSidebarOpen(false);
      }
    },
    threshold: 50,
    edgeThreshold: 30,
    enabled: isMobileView,
    requireEdgeStart: !isSidebarOpen, // Disable edge detection when sidebar is open
  });

  // Handle overlay click (mobile only)
  const handleOverlayClick = () => {
    if (isMobileView) {
      setSidebarOpen(false);
    }
  };

  return (
    <div className="flex h-full w-full relative">
      {/* Hamburger menu for mobile */}
      {isMobileView && !isSidebarOpen && (
        <header className="fixed top-0 left-0 right-0 z-30 bg-surface-primary border-b border-border px-3 py-2 flex items-center gap-2">
          <button
            onClick={() => setSidebarOpen(true)}
            className="p-2 text-fg-secondary hover:text-fg-default hover:bg-surface-secondary rounded-lg transition-colors flex-shrink-0"
            aria-label="open-sidebar"
          >
            <Menu className="w-5 h-5" />
          </button>

          {showSkeleton ? (
            <div className="flex items-center gap-2 flex-1 min-w-0 p-2">
              <div className="w-5 h-5 bg-border rounded animate-pulse flex-shrink-0" />
              <div className="h-5 bg-border rounded animate-pulse w-32" />
            </div>
          ) : (
            pageTitle && (
              <button
                onClick={handleTitleClick}
                className={`flex items-center gap-2 flex-1 min-w-0 ${
                  isChatPage
                    ? 'hover:bg-surface-secondary rounded-lg p-2 transition-colors'
                    : 'cursor-default'
                }`}
                disabled={!isChatPage}
              >
                {pageIcon}
                <h1 className="text-base font-semibold text-fg-default truncate">{pageTitle}</h1>
              </button>
            )
          )}

          {isChatPage && (
            <Link
              to="/chat"
              onClick={handleNewChat}
              className="p-2 text-fg-secondary hover:text-fg-default hover:bg-surface-secondary rounded-lg transition-colors flex-shrink-0"
              aria-label={t('navigation.newChat')}
              title={t('navigation.newChat')}
            >
              <SquarePen className="w-5 h-5" />
            </Link>
          )}

          {/* Render mobile header action from store */}
          {mobileHeaderAction}
        </header>
      )}

      {/* Overlay background for mobile */}
      {isMobileView && isSidebarOpen && (
        <div className="fixed inset-0 bg-black bg-opacity-50 z-40" onClick={handleOverlayClick} />
      )}

      {/* Sidebar */}
      {isMobileView ? (
        // Mobile: Overlay sidebar
        <div
          className={`
            fixed top-0 left-0 h-full z-50 transition-transform duration-300 ease-in-out
            ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full'}
          `}
        >
          <SessionSidebar />
        </div>
      ) : (
        // Desktop: Normal sidebar
        <div
          className={`
            transition-all duration-300 ease-in-out flex-shrink-0
            ${isSidebarOpen ? 'w-80' : 'w-16'}
          `}
        >
          <SessionSidebar />
        </div>
      )}

      {/* Main content area */}
      <div
        className={`flex-1 flex flex-col min-w-0 bg-surface-primary ${isMobileView && !isSidebarOpen ? 'pt-12' : ''}`}
      >
        <Outlet />
      </div>

      {/* Select agent modal */}
      <AgentSelectorModal
        isOpen={isAgentModalOpen}
        onClose={() => setIsAgentModalOpen(false)}
        onAgentSelect={handleAgentSelect}
      />

      {/* Keyboard shortcuts help modal */}
      <ShortcutsModal isOpen={isShortcutsHelpOpen} onClose={closeShortcutsHelp} />
    </div>
  );
}
