import { useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from './stores/authStore';
import { useThemeStore } from './stores/themeStore';
import { AuthContainer } from './features/auth/AuthContainer';
import { MainLayout } from './layouts/MainLayout';
import { HomePage } from './pages/HomePage';
import { ChatPage } from './pages/ChatPage';
import { ToolsPage } from './pages/ToolsPage';
import { AgentDirectoryPage } from './pages/AgentDirectoryPage';
import { SearchChatPage } from './pages/SearchChatPage';
import { EventsPage } from './pages/EventsPage';
import { SettingsPage } from './pages/SettingsPage';
import { authService } from './lib/auth';
import { useAgentStore } from './stores/agentStore';
import { ErrorBoundary } from './components/ErrorBoundary';
import { useAppSyncConnection } from './hooks/useAppSyncConnection';
import { CommandPalette, useCommandPalette } from './components/ui/CommandPalette';
import { LoadingIndicator } from './components/ui/LoadingIndicator';
import { logger } from './utils/logger';

function App() {
  const { t } = useTranslation();
  const { user, isAuthenticated, isBootstrapped, setUser, setLoading, setBootstrapped } =
    useAuthStore();
  const { initializeStore, clearStore } = useAgentStore();

  // Initialize theme
  const initializeTheme = useThemeStore((state) => state.initialize);
  useEffect(() => {
    initializeTheme();
  }, [initializeTheme]);

  /**
   * Bootstrap + Hub subscription.
   *
   * WHY a single useEffect with no deps beyond stable setters: this is the
   * application's single source of auth state synchronization.
   *
   *   - Bootstrap: `authService.currentUser()` reads Amplify's authoritative
   *     state on page load and seeds the Zustand store. We do not rely on
   *     persisted `isAuthenticated` any more.
   *
   *   - Hub subscription: Amplify emits `signedIn`, `signedOut`, and
   *     `tokenRefresh_failure` events that originate from anywhere — another
   *     tab, an automatic refresh that failed, an explicit `signOut()` call.
   *     Mirroring those to Zustand in one place means no component needs to
   *     duplicate "am I still signed in?" logic.
   *
   *   - `sessionEnded`: one single toast. Previously the 401 retry path in
   *     `BaseApiClient` + `errorHandler` could fire the same toast multiple
   *     times from concurrent requests.
   */
  useEffect(() => {
    let cancelled = false;

    const bootstrap = async () => {
      setLoading(true);
      try {
        const existingUser = await authService.currentUser();
        if (!cancelled) setUser(existingUser ?? null);
      } catch (err) {
        logger.error('Session bootstrap error:', err);
        if (!cancelled) setUser(null);
      } finally {
        if (!cancelled) {
          setLoading(false);
          // WHY set bootstrapped last: Routing decisions in the render below
          // are gated on this flag. Until it flips to `true` we render a
          // neutral loading screen so neither <AuthContainer /> (which has a
          // catch-all `<Navigate to="/login" />`) nor the authenticated
          // `<Navigate to="/chat" />` catch-all can rewrite the URL before
          // we know who the user is. That preserves deep-linked paths like
          // `/chat/:sessionId` or `/settings` across a hard reload.
          setBootstrapped(true);
        }
      }
    };
    bootstrap();

    const unsubscribe = authService.onAuthEvent((event) => {
      switch (event.type) {
        case 'signedIn':
          setUser(event.user);
          break;
        case 'signedOut':
          setUser(null);
          break;
        case 'sessionEnded': {
          // Only surface a toast for involuntary session loss. Explicit
          // sign-out is a normal navigation and should stay silent.
          if (event.reason === 'refreshFailed' || event.reason === 'revoked') {
            toast.error(t('error.sessionExpired'), { duration: 5000 });
          }
          setUser(null);
          break;
        }
      }
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [setUser, setLoading, setBootstrapped, t]);

  // Initialize AgentStore when user is authenticated
  useEffect(() => {
    if (user) {
      logger.log('User authenticated, initializing AgentStore...');
      initializeStore();
    } else {
      logger.log('User logged out, clearing AgentStore...');
      clearStore();
    }
  }, [user, initializeStore, clearStore]);

  // Initialize shared AppSync WebSocket connection
  useAppSyncConnection();

  // Command Palette state
  const { isOpen: isCommandPaletteOpen, close: closeCommandPalette } = useCommandPalette();

  return (
    <ErrorBoundary>
      <Toaster
        position="top-right"
        toastOptions={{
          duration: 3000,
          style: {
            background: '#363636',
            color: '#fff',
            borderRadius: '12px',
          },
          success: {
            iconTheme: {
              primary: '#10b981',
              secondary: '#fff',
            },
          },
          error: {
            iconTheme: {
              primary: '#ef4444',
              secondary: '#fff',
            },
          },
        }}
      />
      <BrowserRouter>
        {/* Command Palette - Global */}
        {isAuthenticated && (
          <CommandPalette isOpen={isCommandPaletteOpen} onClose={closeCommandPalette} />
        )}
        {!isBootstrapped ? (
          // WHY a neutral gate before Routes mount: see bootstrap() comment.
          // Rendering <AuthContainer /> even for one frame on reload fires
          // its catch-all `<Navigate to="/login" />` and overwrites the
          // current URL with `replace`, which then collapses to `/chat`
          // via the authenticated catch-all once the session resolves.
          <div className="h-screen flex items-center justify-center">
            <LoadingIndicator size="lg" />
          </div>
        ) : isAuthenticated ? (
          <div className="h-screen flex">
            <Routes>
              <Route element={<MainLayout />}>
                <Route path="/" element={<HomePage />} />
                <Route path="/chat" element={<ChatPage />} />
                <Route path="/chat/:sessionId" element={<ChatPage />} />
                <Route path="/chat/search" element={<SearchChatPage />} />
                <Route path="/agents" element={<AgentDirectoryPage />} />
                <Route path="/tools" element={<ToolsPage />} />
                <Route path="/events" element={<EventsPage />} />
                <Route path="/settings" element={<SettingsPage />} />
              </Route>
              <Route path="*" element={<Navigate to="/chat" replace />} />
            </Routes>
          </div>
        ) : (
          <AuthContainer />
        )}
      </BrowserRouter>
    </ErrorBoundary>
  );
}

export default App;
