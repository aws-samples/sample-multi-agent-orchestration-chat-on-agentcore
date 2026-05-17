/**
 * SearchSection Molecule Component
 * Reusable search input with button, clear, and results info.
 * Used in ToolsPage and AgentDirectoryPage.
 */

import React from 'react';
import { Search, XCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '../Button';
import { cn } from '../../../lib/utils';

export interface SearchSectionProps {
  /** Current search input value */
  value: string;
  /** Input change handler */
  onChange: (value: string) => void;
  /** Search submit handler */
  onSearch: () => void;
  /** Clear handler */
  onClear: () => void;
  /** Loading state */
  isSearching?: boolean;
  /** Placeholder text */
  placeholder?: string;
  /** Section title */
  title?: string;
  /** Active search query (displayed below input) */
  activeQuery?: string;
  /** Additional class names */
  className?: string;
}

export const SearchSection: React.FC<SearchSectionProps> = ({
  value,
  onChange,
  onSearch,
  onClear,
  isSearching = false,
  placeholder,
  title,
  activeQuery,
  className,
}) => {
  const { t } = useTranslation();

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      onSearch();
    }
  };

  return (
    <div className={cn('bg-surface-secondary border border-border rounded-card p-4', className)}>
      {title && (
        <div className="flex items-center gap-2 mb-3">
          <Search className="w-4 h-4 text-fg-secondary" />
          <h2 className="text-sm font-medium text-fg-default">{title}</h2>
        </div>
      )}

      <div className="flex gap-3">
        <div className="flex-1 relative">
          <input
            type="text"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyPress={handleKeyPress}
            placeholder={placeholder}
            className={cn(
              'w-full px-3 py-2 border border-border rounded-input text-sm',
              'bg-surface-primary text-fg-default',
              'focus:outline-none focus:ring-2 focus:ring-border-focus focus:border-transparent',
              'placeholder:text-fg-disabled'
            )}
          />
          {value && (
            <button
              onClick={onClear}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-fg-disabled hover:text-fg-secondary"
            >
              <XCircle className="w-4 h-4" />
            </button>
          )}
        </div>
        <Button
          variant="primary"
          size="md"
          onClick={onSearch}
          disabled={isSearching || !value.trim()}
          loading={isSearching}
        >
          {!isSearching && t('common.search')}
        </Button>
      </div>

      {activeQuery && (
        <div className="mt-3 flex items-center gap-2 text-xs text-fg-secondary">
          <span>
            {t('tool.searchingFor')}: {activeQuery}
          </span>
          <button onClick={onClear} className="text-fg-link hover:underline font-medium">
            {t('common.clear')}
          </button>
        </div>
      )}
    </div>
  );
};
