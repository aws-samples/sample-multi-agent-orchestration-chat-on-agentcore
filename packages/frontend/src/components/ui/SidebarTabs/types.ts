import type { ComponentType } from 'react';

/**
 * Type definition for tab item
 */
export interface TabItem<T extends string = string> {
  /** Tab ID (unique identifier) */
  id: T;
  /** Tab label (display name) */
  label: string;
  /** Tab icon component */
  icon: ComponentType<{ className?: string }>;
}

/**
 * Props for SidebarTabs component
 */
export interface SidebarTabsProps<T extends string = string> {
  /** List of tabs */
  tabs: TabItem<T>[];
  /** ID of the currently active tab */
  activeTab: T;
  /** Callback when tab changes */
  onTabChange: (tabId: T) => void;
  /** Additional class name (optional) */
  className?: string;
}

/**
 * Props for SidebarTabsLayout component
 */
export interface SidebarTabsLayoutProps<T extends string = string> {
  /** List of tabs */
  tabs: TabItem<T>[];
  /** ID of the currently active tab */
  activeTab: T;
  /** Callback when tab changes */
  onTabChange: (tabId: T) => void;
  /** Child elements to display in the content area */
  children: React.ReactNode;
}
