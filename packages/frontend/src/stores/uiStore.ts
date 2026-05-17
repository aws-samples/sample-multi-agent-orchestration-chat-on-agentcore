/**
 * UI State Management Store
 * Manages UI elements such as sidebar open/close state
 */

import { create } from 'zustand';
import { devtools, persist } from 'zustand/middleware';
import type React from 'react';

interface UIState {
  /**
   * Whether the sidebar is open
   */
  isSidebarOpen: boolean;

  /**
   * Whether in mobile view (less than 768px)
   */
  isMobileView: boolean;

  /**
   * Whether in narrow desktop view (768px to 1024px)
   */
  isNarrowDesktop: boolean;

  /**
   * Actions (buttons, etc.) to display in the mobile header
   */
  mobileHeaderAction: React.ReactNode | null;

  /**
   * Toggle sidebar open/close
   */
  toggleSidebar: () => void;

  /**
   * Set sidebar open/close state
   * @param isOpen Open/close state
   */
  setSidebarOpen: (isOpen: boolean) => void;

  /**
   * Set mobile view state
   * @param isMobile Mobile view state
   */
  setMobileView: (isMobile: boolean) => void;

  /**
   * Set narrow desktop view state
   * @param isNarrow Narrow desktop view state
   */
  setNarrowDesktop: (isNarrow: boolean) => void;

  /**
   * Set mobile header action
   * @param action React node to render
   */
  setMobileHeaderAction: (action: React.ReactNode | null) => void;
}

/**
 * UI state management store
 */
export const useUIStore = create<UIState>()(
  devtools(
    persist(
      (set) => ({
        // Default: sidebar open
        isSidebarOpen: true,

        // Default: desktop view
        isMobileView: false,

        // Default: wide desktop
        isNarrowDesktop: false,

        // Default: no mobile header action
        mobileHeaderAction: null,

        toggleSidebar: () => set((state) => ({ isSidebarOpen: !state.isSidebarOpen })),

        setSidebarOpen: (isOpen) => set({ isSidebarOpen: isOpen }),

        setMobileView: (isMobile) => set({ isMobileView: isMobile }),

        setNarrowDesktop: (isNarrow) => set({ isNarrowDesktop: isNarrow }),

        setMobileHeaderAction: (action) => set({ mobileHeaderAction: action }),
      }),
      {
        name: 'ui-storage',
        partialize: (state) => ({ isSidebarOpen: state.isSidebarOpen }),
      }
    ),
    {
      name: 'ui-store',
      enabled: import.meta.env.DEV,
    }
  )
);
