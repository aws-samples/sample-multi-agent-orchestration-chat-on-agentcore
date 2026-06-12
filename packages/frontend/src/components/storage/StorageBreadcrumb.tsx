/**
 * Breadcrumb path navigation for the storage modal, with a large-directory
 * size-warning tooltip on the right. Presentational leaf — derives its path
 * segments from `currentPath` and emits navigation callbacks.
 */

import { useTranslation } from 'react-i18next';
import { Home, ChevronRight, AlertTriangle } from 'lucide-react';
import { Tooltip } from '../ui/Tooltip/Tooltip';
import { formatBytes } from '../../utils/formatBytes';

export interface StorageBreadcrumbProps {
  currentPath: string;
  onNavigate: (path: string) => void;
  onNavigateToRoot: () => void;
  /** Set when the current directory exceeds the size threshold; null otherwise. */
  sizeWarning: { show: boolean; totalSize: number; fileCount: number } | null;
}

export function StorageBreadcrumb({
  currentPath,
  onNavigate,
  onNavigateToRoot,
  sizeWarning,
}: StorageBreadcrumbProps) {
  const { t } = useTranslation();
  const pathSegments = currentPath.split('/').filter(Boolean);

  return (
    <div className="px-4 md:px-6 py-3 border-b border-border bg-surface-primary">
      <div className="flex items-center gap-2">
        {/* Breadcrumb section (scrollable) */}
        <div className="flex items-center gap-1 text-sm overflow-x-auto flex-1 min-w-0">
          <button
            onClick={onNavigateToRoot}
            className="flex items-center gap-1 px-2 py-1 text-fg-secondary hover:text-fg-default hover:bg-surface-secondary rounded transition-colors whitespace-nowrap"
          >
            <Home className="w-4 h-4 flex-shrink-0" />
            <span>{t('storage.root')}</span>
          </button>

          {pathSegments.map((segment, index) => {
            const segmentPath = '/' + pathSegments.slice(0, index + 1).join('/');
            return (
              <div key={segmentPath} className="flex items-center gap-1">
                <ChevronRight className="w-4 h-4 text-fg-disabled flex-shrink-0" />
                <button
                  onClick={() => onNavigate(segmentPath)}
                  className="px-2 py-1 text-fg-secondary hover:text-fg-default hover:bg-surface-secondary rounded transition-colors truncate max-w-[120px] sm:max-w-none"
                >
                  {segment}
                </button>
              </div>
            );
          })}
        </div>

        {/* Directory size warning icon (outside overflow container) */}
        {sizeWarning?.show && (
          <Tooltip
            content={
              <div className="text-xs leading-relaxed">
                <p className="font-medium">{t('storage.largeSizeWarningTitle')}</p>
                <p className="mt-1">
                  {t('storage.largeSizeWarningMessage', {
                    size: formatBytes(sizeWarning.totalSize, { maxUnit: 'GB' }),
                    count: sizeWarning.fileCount,
                  })}
                </p>
              </div>
            }
            position="left"
            width="320px"
          >
            <div className="flex-shrink-0 p-1 cursor-help">
              <AlertTriangle className="w-4 h-4 text-amber-500" />
            </div>
          </Tooltip>
        )}
      </div>
    </div>
  );
}
