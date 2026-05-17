import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Search, X, AlertCircle, Check } from 'lucide-react';
import { useToolStore } from '../stores/toolStore';
import { LoadingIndicator } from './ui/LoadingIndicator';
import { getToolIcon } from '../utils/toolIcons';

interface ToolSelectorProps {
  selectedTools: string[];
  onSelectionChange: (selectedTools: string[]) => void;
  disabled?: boolean;
}

export const ToolSelector: React.FC<ToolSelectorProps> = ({
  selectedTools,
  onSelectionChange,
  disabled = false,
}) => {
  const { t } = useTranslation();
  const { tools, isLoading, error, loadAllTools } = useToolStore();
  const [searchQuery, setSearchQuery] = useState('');
  const [showSelectedOnly, setShowSelectedOnly] = useState(false);

  // Get tool list (load all pages)
  useEffect(() => {
    if (tools.length === 0 && !isLoading && !error) {
      loadAllTools();
    }
  }, [tools.length, isLoading, error, loadAllTools]);

  // Search filtering (using useMemo for performance improvement)
  const filteredTools = React.useMemo(() => {
    if (!searchQuery.trim()) {
      return tools;
    }

    const query = searchQuery.toLowerCase();
    return tools.filter(
      (tool) =>
        tool.name.toLowerCase().includes(query) ||
        (tool.description && tool.description.toLowerCase().includes(query))
    );
  }, [tools, searchQuery]);

  // Combine search filter with "selected only" filter
  const visibleTools = React.useMemo(() => {
    if (!showSelectedOnly) return filteredTools;
    return filteredTools.filter((tool) => selectedTools.includes(tool.name));
  }, [filteredTools, showSelectedOnly, selectedTools]);

  // Toggle tool selection
  const toggleTool = (toolName: string) => {
    if (disabled) return;

    const isSelected = selectedTools.includes(toolName);
    let newSelection: string[];

    if (isSelected) {
      newSelection = selectedTools.filter((name) => name !== toolName);
    } else {
      newSelection = [...selectedTools, toolName];
    }

    onSelectionChange(newSelection);
  };

  // Select all/deselect all
  const toggleAllTools = () => {
    if (disabled) return;

    const allToolNames = visibleTools.map((tool) => tool.name);
    const allSelected = allToolNames.every((name) => selectedTools.includes(name));

    if (allSelected) {
      // Deselect all displayed tools
      const newSelection = selectedTools.filter((name) => !allToolNames.includes(name));
      onSelectionChange(newSelection);
    } else {
      // Select all displayed tools
      const newSelection = [...new Set([...selectedTools, ...allToolNames])];
      onSelectionChange(newSelection);
    }
  };

  const allVisibleSelected =
    visibleTools.length > 0 && visibleTools.every((tool) => selectedTools.includes(tool.name));

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-fg-default">{t('tool.selector.availableTools')}</h3>
        <span className="text-xs text-fg-muted">
          {t('tool.selector.selectedCount', {
            selected: selectedTools.length,
            total: tools.length,
          })}
        </span>
      </div>

      {/* Search box */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-fg-disabled w-4 h-4" />
        <input
          type="text"
          placeholder={t('tool.selector.searchPlaceholder')}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          disabled={disabled || isLoading}
          className="w-full pl-10 pr-4 py-2 border border-border-strong rounded-lg text-sm bg-surface-primary text-fg-default placeholder:text-fg-disabled focus:ring-2 focus:ring-border-focus focus:border-transparent disabled:bg-surface-secondary disabled:cursor-not-allowed"
        />
        {searchQuery && (
          <button
            type="button"
            onClick={() => setSearchQuery('')}
            className="absolute right-3 top-1/2 transform -translate-y-1/2 text-fg-disabled hover:text-fg-secondary"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Filters row: Select all + Selected-only toggle */}
      <div className="flex items-center justify-between gap-3">
        {visibleTools.length > 0 ? (
          <button
            type="button"
            onClick={toggleAllTools}
            disabled={disabled || isLoading}
            className="text-sm text-action-primary hover:text-action-primary disabled:text-fg-disabled disabled:cursor-not-allowed"
          >
            {allVisibleSelected
              ? t('tool.selector.deselectAllVisible')
              : t('tool.selector.selectAllVisible')}
          </button>
        ) : (
          <span />
        )}

        {(() => {
          const toggleDisabled =
            disabled || isLoading || (selectedTools.length === 0 && !showSelectedOnly);
          return (
            <button
              type="button"
              onClick={() => setShowSelectedOnly((v) => !v)}
              disabled={toggleDisabled}
              aria-pressed={showSelectedOnly}
              className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                showSelectedOnly
                  ? 'bg-action-primary text-white border-action-primary'
                  : 'bg-surface-primary text-fg-secondary border-border-strong hover:bg-surface-secondary'
              } ${toggleDisabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
            >
              <Check className="w-3.5 h-3.5" />
              {t('tool.selector.showSelectedOnly')} ({selectedTools.length})
            </button>
          );
        })()}
      </div>

      {/* Loading state */}
      {isLoading && <LoadingIndicator message={t('tool.loadingTools')} spacing="lg" />}

      {/* Error state */}
      {error && (
        <div className="flex items-center space-x-2 p-3 bg-feedback-error-bg border border-feedback-error-border rounded-lg">
          <AlertCircle className="w-4 h-4 text-feedback-error flex-shrink-0" />
          <span className="text-sm text-feedback-error">{error}</span>
        </div>
      )}

      {/* Tool list */}
      {!isLoading && !error && (
        <div className="space-y-2 max-h-[50vh] overflow-y-auto border border-border rounded-lg p-2">
          {visibleTools.length === 0 ? (
            <div className="p-4 text-center text-fg-muted text-sm">
              {searchQuery ? t('tool.selector.noSearchResults') : t('tool.selector.noTools')}
            </div>
          ) : (
            visibleTools.map((tool) => {
              const isSelected = selectedTools.includes(tool.name);
              return (
                <div
                  key={tool.name}
                  onClick={() => toggleTool(tool.name)}
                  className={`flex items-start space-x-3 p-3 rounded-md cursor-pointer hover:bg-surface-secondary transition-colors ${
                    isSelected ? 'bg-action-primary/5' : ''
                  } ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}
                >
                  {/* Tool icon (border color changes based on selection state) */}
                  <div
                    className={`flex-shrink-0 w-6 h-6 rounded-lg flex items-center justify-center transition-all duration-200 ${
                      isSelected
                        ? 'bg-action-primary text-white border-1 border-blue-500 shadow-sm'
                        : 'bg-surface-secondary text-fg-secondary border border-border hover:border-feedback-info-border hover:bg-feedback-info-bg'
                    }`}
                  >
                    {getToolIcon(tool.name, 'w-3 h-3')}
                  </div>

                  {/* Tool information */}
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-fg-default">{tool.name}</div>
                    {tool.description && (
                      <div
                        className="text-xs text-fg-muted mt-1 line-clamp-3"
                        title={tool.description}
                      >
                        {tool.description}
                      </div>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
};
