import React, { useState, useRef, useEffect } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { icons, Search, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../../lib/utils';

interface IconPickerProps {
  value?: string;
  onChange: (iconName: string) => void;
  disabled?: boolean;
  className?: string;
}

export const IconPicker: React.FC<IconPickerProps> = ({
  value = 'Bot',
  onChange,
  disabled = false,
  className,
}) => {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Get all icon names
  const allIconNames = Object.keys(icons).filter(
    (name) => name !== 'createLucideIcon' && name !== 'icons'
  );

  // Filter by search
  const filteredIcons = searchQuery
    ? allIconNames.filter((name) => name.toLowerCase().includes(searchQuery.toLowerCase()))
    : allIconNames;

  // Selected icon component
  const SelectedIcon = (icons[value as keyof typeof icons] as LucideIcon) || icons.Bot;

  // Virtual scroll settings (8-column grid)
  const columnCount = 8;
  const rowCount = Math.ceil(filteredIcons.length / columnCount);

  // eslint-disable-next-line react-hooks/incompatible-library
  const rowVirtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 68, // Height of each row (square button + gap)
    overscan: 5,
  });

  // Close on outside click
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
        setSearchQuery('');
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      // Focus search input
      setTimeout(() => searchInputRef.current?.focus(), 0);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  // Close on ESC key
  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && isOpen) {
        setIsOpen(false);
        setSearchQuery('');
      }
    };

    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('keydown', handleEscape);
    };
  }, [isOpen]);

  const handleIconSelect = (iconName: string) => {
    onChange(iconName);
    setIsOpen(false);
    setSearchQuery('');
  };

  return (
    <div ref={containerRef} className={cn('relative', className)}>
      {/* Icon display button */}
      <button
        type="button"
        onClick={() => !disabled && setIsOpen(!isOpen)}
        disabled={disabled}
        className={cn(
          'w-11 h-11 bg-surface-secondary rounded-lg flex items-center justify-center flex-shrink-0 transition-colors',
          !disabled && 'hover:bg-border cursor-pointer',
          disabled && 'opacity-50 cursor-not-allowed',
          isOpen && 'ring-2 ring-blue-500'
        )}
        title={t('common.clickToSelectIcon')}
      >
        <SelectedIcon className="w-6 h-6 text-fg-secondary" />
      </button>

      {/* Popover */}
      {isOpen && (
        <div className="absolute top-14 left-0 z-50 w-[520px] bg-surface-primary rounded-xl shadow-2xl border border-border overflow-hidden">
          {/* Search bar */}
          <div className="p-3 border-b border-border bg-surface-secondary">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-fg-disabled" />
              <input
                ref={searchInputRef}
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={t('common.searchIconsPlaceholder')}
                className="w-full pl-9 pr-9 py-2 text-sm border border-border-strong rounded-lg bg-surface-primary text-fg-default focus:ring-2 focus:ring-border-focus focus:border-transparent"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-fg-disabled hover:text-fg-secondary"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>
            <p className="text-xs text-fg-muted mt-2">
              {t('common.iconsCount', { count: filteredIcons.length })}
            </p>
          </div>

          {/* Icon grid (virtual scroll) */}
          <div ref={scrollRef} className="p-3 max-h-[400px] overflow-y-auto">
            {filteredIcons.length > 0 ? (
              <div
                style={{
                  height: `${rowVirtualizer.getTotalSize()}px`,
                  width: '100%',
                  position: 'relative',
                }}
              >
                {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                  const startIndex = virtualRow.index * columnCount;
                  const rowIcons = filteredIcons.slice(startIndex, startIndex + columnCount);

                  return (
                    <div
                      key={virtualRow.index}
                      style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        width: '100%',
                        height: `${virtualRow.size}px`,
                        transform: `translateY(${virtualRow.start}px)`,
                      }}
                      className="grid grid-cols-8 gap-2"
                    >
                      {rowIcons.map((iconName) => {
                        const IconComponent = icons[iconName as keyof typeof icons] as LucideIcon;
                        const isSelected = iconName === value;

                        return (
                          <button
                            key={iconName}
                            type="button"
                            onClick={() => handleIconSelect(iconName)}
                            className={cn(
                              'w-14 h-14 flex flex-col items-center justify-center rounded-lg transition-all group',
                              isSelected
                                ? 'bg-blue-100 text-action-primary ring-2 ring-blue-500'
                                : 'hover:bg-surface-secondary text-fg-secondary hover:text-fg-default'
                            )}
                          >
                            <IconComponent className="w-5 h-5 flex-shrink-0" />
                            <span
                              className={cn(
                                'text-[8px] mt-0.5 truncate max-w-[48px] leading-tight',
                                isSelected ? 'text-action-primary' : 'text-fg-muted'
                              )}
                              title={iconName}
                            >
                              {iconName}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="text-center py-8 text-fg-disabled text-sm">
                {t('common.noIconsFound', { query: searchQuery })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
