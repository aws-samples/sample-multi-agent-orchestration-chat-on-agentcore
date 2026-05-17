/**
 * Theme Store
 * Manages theme state (light/dark/system) with localStorage persistence
 * and OS preference detection.
 */

import { create } from 'zustand';
import { devtools, persist } from 'zustand/middleware';

export type Theme = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

/**
 * Resolve the effective theme based on user preference and OS setting.
 */
function resolveTheme(theme: Theme): ResolvedTheme {
  if (theme === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return theme;
}

/**
 * Apply the resolved theme to the document root element.
 */
function applyTheme(resolvedTheme: ResolvedTheme): void {
  document.documentElement.setAttribute('data-theme', resolvedTheme);
}

interface ThemeState {
  /** User-selected theme preference */
  theme: Theme;
  /** Resolved effective theme (light or dark) */
  resolvedTheme: ResolvedTheme;
  /** Set theme preference and apply it */
  setTheme: (theme: Theme) => void;
  /** Initialize theme and start listening for OS changes */
  initialize: () => void;
  /** Cleanup event listeners */
  cleanup: () => void;
  /** Internal: media query change handler reference */
  _cleanupFn: (() => void) | null;
}

export const useThemeStore = create<ThemeState>()(
  devtools(
    persist(
      (set, get) => ({
        theme: 'light',
        resolvedTheme: 'light',
        _cleanupFn: null,

        setTheme: (theme: Theme) => {
          const resolved = resolveTheme(theme);
          applyTheme(resolved);
          set({ theme, resolvedTheme: resolved });
        },

        initialize: () => {
          // Clean up any previous listener
          const existingCleanup = get()._cleanupFn;
          if (existingCleanup) {
            existingCleanup();
          }

          const theme = get().theme;
          const resolved = resolveTheme(theme);
          applyTheme(resolved);
          set({ resolvedTheme: resolved });

          // Listen for OS theme changes when "system" is selected
          const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
          const handleChange = () => {
            const currentTheme = get().theme;
            if (currentTheme === 'system') {
              const newResolved = resolveTheme('system');
              applyTheme(newResolved);
              set({ resolvedTheme: newResolved });
            }
          };
          mediaQuery.addEventListener('change', handleChange);

          // Store cleanup function
          set({
            _cleanupFn: () => {
              mediaQuery.removeEventListener('change', handleChange);
            },
          });
        },

        cleanup: () => {
          const cleanupFn = get()._cleanupFn;
          if (cleanupFn) {
            cleanupFn();
            set({ _cleanupFn: null });
          }
        },
      }),
      {
        name: 'moca-theme',
        partialize: (state) => ({
          theme: state.theme,
        }),
      }
    ),
    {
      name: 'theme-store',
      enabled: import.meta.env.DEV,
    }
  )
);
