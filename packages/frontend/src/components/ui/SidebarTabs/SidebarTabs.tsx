import type { SidebarTabsProps, SidebarTabsLayoutProps } from './types';
import { useUIStore } from '../../../stores/uiStore';

/**
 * Sidebar tab navigation component
 * Desktop: vertical tabs on the left
 * Mobile: horizontal tabs at the top
 */
export function SidebarTabs<T extends string>({
  tabs,
  activeTab,
  onTabChange,
  className = '',
}: SidebarTabsProps<T>) {
  const { isMobileView } = useUIStore();

  if (isMobileView) {
    // Mobile: horizontal tabs at the top
    return (
      <div className={`w-full border-b border-border flex-shrink-0 ${className}`}>
        <nav className="flex space-x-1 px-4 py-2 overflow-x-auto">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => onTabChange(tab.id)}
                className={`flex items-center space-x-2 px-4 py-2 rounded-lg text-sm whitespace-nowrap transition-colors ${
                  isActive
                    ? 'bg-feedback-info-bg text-action-primary font-medium'
                    : 'text-fg-secondary hover:bg-surface-secondary'
                }`}
              >
                <Icon className="w-4 h-4 flex-shrink-0" />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </nav>
      </div>
    );
  }

  // Desktop: vertical tabs on the left
  return (
    <div className={`w-48 border-r border-border flex-shrink-0 ${className}`}>
      <nav className="p-4 space-y-1">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => onTabChange(tab.id)}
              className={`w-full flex items-center space-x-3 px-3 py-2 rounded-lg text-sm transition-colors ${
                isActive
                  ? 'bg-feedback-info-bg text-action-primary font-medium'
                  : 'text-fg-secondary hover:bg-surface-secondary'
              }`}
            >
              <Icon className="w-5 h-5 flex-shrink-0" />
              <span>{tab.label}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}

/**
 * Sidebar tab layout component
 * Desktop: sidebar tabs (left) + content (right)
 * Mobile: tabs (top) + content (bottom)
 */
export function SidebarTabsLayout<T extends string>({
  tabs,
  activeTab,
  onTabChange,
  children,
}: SidebarTabsLayoutProps<T>) {
  const { isMobileView } = useUIStore();

  return (
    <div className={`flex ${isMobileView ? 'flex-col' : 'flex-row'}`}>
      <SidebarTabs tabs={tabs} activeTab={activeTab} onTabChange={onTabChange} />
      <div className="flex-1 flex flex-col">{children}</div>
    </div>
  );
}
