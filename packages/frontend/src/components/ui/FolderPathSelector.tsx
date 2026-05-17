import { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { X, AlertCircle } from 'lucide-react';
import { FolderTree } from '../FolderTree';
import { useStorageStore } from '../../stores/storageStore';

interface FolderPathSelectorProps {
  value?: string;
  onChange: (path: string | undefined) => void;
  disabled?: boolean;
  id?: string;
}

/**
 * Calculate parent paths from a given path
 */
function getParentPaths(path: string | undefined): string[] {
  if (!path) return ['/'];
  const parts = path.split('/').filter(Boolean);
  const paths: string[] = ['/'];
  let currentPath = '';
  for (const part of parts) {
    currentPath = currentPath ? `${currentPath}/${part}` : `/${part}`;
    paths.push(currentPath);
  }
  return paths;
}

export const FolderPathSelector: React.FC<FolderPathSelectorProps> = ({
  value,
  onChange,
  disabled = false,
  id = 'folderPathSelector',
}) => {
  const { t } = useTranslation();

  // Use storageStore for folder tree (Stale-While-Revalidate pattern)
  const folderTree = useStorageStore((state) => state.folderTree);
  const isTreeLoading = useStorageStore((state) => state.isTreeLoading);
  const loadFolderTree = useStorageStore((state) => state.loadFolderTree);
  const error = useStorageStore((state) => state.error);

  // Calculate paths that should be expanded based on value
  const valueExpandedPaths = useMemo(() => getParentPaths(value), [value]);

  // Local state for manually toggled paths (component-specific)
  const [manuallyExpandedPaths, setManuallyExpandedPaths] = useState<string[]>(['/']);

  // Combine value-derived paths with manually expanded paths
  const expandedPaths = useMemo(
    () => [...new Set([...valueExpandedPaths, ...manuallyExpandedPaths])],
    [valueExpandedPaths, manuallyExpandedPaths]
  );

  // Load folder tree on mount (uses Stale-While-Revalidate in store)
  useEffect(() => {
    loadFolderTree();
  }, [loadFolderTree]);

  const handleToggleExpand = useCallback((path: string) => {
    setManuallyExpandedPaths((prev) =>
      prev.includes(path) ? prev.filter((p) => p !== path) : [...prev, path]
    );
  }, []);

  const handleSelect = useCallback(
    (path: string) => {
      if (!disabled) {
        onChange(path);
      }
    },
    [disabled, onChange]
  );

  const handleClear = useCallback(() => {
    if (!disabled) {
      onChange('');
    }
  }, [disabled, onChange]);

  return (
    <div id={id} className="space-y-2">
      {/* Selected path display */}
      {value && (
        <div className="flex items-center justify-between px-3 py-2 bg-feedback-info-bg border border-action-primary rounded-input">
          <span className="text-sm text-action-primary truncate">{value}</span>
          <button
            type="button"
            onClick={handleClear}
            disabled={disabled}
            className="p-0.5 hover:bg-border rounded transition-colors disabled:opacity-50"
          >
            <X className="size-4 text-action-primary" />
          </button>
        </div>
      )}

      {/* Folder tree */}
      <div
        className={`border rounded-input bg-surface-primary max-h-48 overflow-y-auto ${
          disabled ? 'opacity-50 pointer-events-none' : ''
        } border-border`}
      >
        <FolderTree
          tree={folderTree}
          selectedPath={value || ''}
          expandedPaths={expandedPaths}
          onSelect={handleSelect}
          onToggleExpand={handleToggleExpand}
          isLoading={isTreeLoading}
        />
      </div>

      {/* Error display */}
      {error && (
        <div className="flex items-center gap-1 text-feedback-error">
          <AlertCircle className="size-4" />
          <p className="text-xs">{t('storage.loadError')}</p>
        </div>
      )}

      {/* No selection hint */}
      {!value && !isTreeLoading && !error && folderTree.length > 0 && (
        <p className="text-xs text-fg-muted">{t('agent.noDefaultStoragePath')}</p>
      )}
    </div>
  );
};
