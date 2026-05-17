/**
 * DropdownMenu Molecule Component
 * Accessible dropdown menu with click-outside handling.
 */

import React, { useState, useRef, useEffect } from 'react';
import { cn } from '../../../lib/utils';

export interface DropdownItem {
  /** Unique key */
  key: string;
  /** Display label */
  label: string;
  /** Optional icon */
  icon?: React.ReactNode;
  /** Click handler */
  onClick: () => void;
  /** Visual variant */
  variant?: 'default' | 'danger';
  /** Disabled state */
  disabled?: boolean;
}

export interface DropdownMenuProps {
  /** Trigger element */
  trigger: React.ReactNode;
  /** Menu items */
  items: DropdownItem[];
  /** Menu alignment */
  align?: 'left' | 'right';
  /** Vertical position */
  position?: 'top' | 'bottom';
  /** Additional class names for menu container */
  className?: string;
  /** Additional class names for the menu panel */
  menuClassName?: string;
}

export const DropdownMenu: React.FC<DropdownMenuProps> = ({
  trigger,
  items,
  align = 'left',
  position = 'bottom',
  className,
  menuClassName,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  // Close on Escape
  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('keydown', handleEscape);
    }

    return () => {
      document.removeEventListener('keydown', handleEscape);
    };
  }, [isOpen]);

  const handleItemClick = (item: DropdownItem) => {
    if (item.disabled) return;
    item.onClick();
    setIsOpen(false);
  };

  const alignClasses = align === 'right' ? 'right-0' : 'left-0';
  const positionClasses = position === 'top' ? 'bottom-full mb-2' : 'top-full mt-1';

  return (
    <div className={cn('relative', className)} ref={menuRef}>
      <div onClick={() => setIsOpen(!isOpen)}>{trigger}</div>

      {isOpen && (
        <div
          className={cn(
            'absolute z-50 min-w-[160px]',
            'bg-surface-elevated rounded-card-lg shadow-elevation-4 border border-border py-1',
            'animate-fade-in',
            alignClasses,
            positionClasses,
            menuClassName
          )}
        >
          {items.map((item) => (
            <button
              key={item.key}
              onClick={() => handleItemClick(item)}
              disabled={item.disabled}
              className={cn(
                'w-full px-3 py-2 text-left text-sm flex items-center gap-2',
                'transition-colors disabled:opacity-50 disabled:cursor-not-allowed',
                item.variant === 'danger'
                  ? 'text-feedback-error hover:bg-action-danger-light'
                  : 'text-fg-default hover:bg-surface-secondary'
              )}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
