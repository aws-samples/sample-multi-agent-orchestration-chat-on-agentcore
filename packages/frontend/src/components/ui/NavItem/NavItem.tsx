/**
 * NavItem Molecule Component
 * Navigation link with icon, label, and optional tooltip for collapsed state.
 */

import React from 'react';
import { Link } from 'react-router-dom';
import type { LucideIcon } from 'lucide-react';
import { Tooltip } from '../Tooltip';
import { cn } from '../../../lib/utils';

export interface NavItemProps {
  /** Navigation target path */
  to: string;
  /** Icon to display */
  icon: LucideIcon;
  /** Label text */
  label: string;
  /** Whether the sidebar is collapsed (icon-only mode) */
  collapsed?: boolean;
  /** Whether this item is currently active */
  active?: boolean;
  /** Click handler (e.g., for clearing state before navigation) */
  onClick?: (e: React.MouseEvent) => void;
  /** Additional class names */
  className?: string;
}

export const NavItem: React.FC<NavItemProps> = ({
  to,
  icon: Icon,
  label,
  collapsed = false,
  active = false,
  onClick,
  className,
}) => {
  const content = (
    <Link
      to={to}
      onClick={onClick}
      className={cn(
        'p-2 rounded-btn transition-colors flex items-center gap-2 no-underline',
        'text-fg-secondary hover:bg-surface-secondary hover:text-fg-default',
        active && 'bg-surface-secondary text-fg-default',
        collapsed ? 'w-auto justify-center' : 'w-full text-left',
        className
      )}
    >
      <Icon className="w-5 h-5 flex-shrink-0" />
      {!collapsed && <span className="text-sm">{label}</span>}
    </Link>
  );

  if (collapsed) {
    return (
      <Tooltip content={label} position="right">
        {content}
      </Tooltip>
    );
  }

  return content;
};
