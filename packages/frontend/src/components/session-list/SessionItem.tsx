import React, { useEffect, useRef, useState, memo } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { MoreHorizontal, Trash2 } from 'lucide-react';
import { cn } from '../../lib/utils';
import type { SessionSummary } from '../../api/sessions';
/**
 * Session Item Component
 */
export interface SessionItemProps {
  session: SessionSummary;
  isActive: boolean;
  isNew?: boolean;
  onDeleteRequest: (sessionId: string) => void;
  /** Rendered left of the link (e.g. an expand toggle); kept outside the link so it does not navigate. */
  leading?: React.ReactNode;
  /** Replaces the title and type badge (child rows label themselves). */
  label?: React.ReactNode;
  trailing?: React.ReactNode;
  /** Child rows in the session tree: smaller, muted, tighter. */
  compact?: boolean;
}

export const SessionItem = memo(function SessionItem({
  session,
  isActive,
  isNew = false,
  onDeleteRequest,
  leading,
  label,
  trailing,
  compact = false,
}: SessionItemProps) {
  const { t } = useTranslation();
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Check session type (default to 'user' for existing sessions without sessionType)
  const sessionType = session.sessionType ?? 'user';
  const isSubAgent = sessionType === 'subagent';
  const isEventTriggered = sessionType === 'event';

  // Close menu on outside click
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsMenuOpen(false);
      }
    };

    if (isMenuOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isMenuOpen]);

  const handleMenuClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsMenuOpen(!isMenuOpen);
  };

  const handleDeleteClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsMenuOpen(false);
    onDeleteRequest(session.sessionId);
  };

  return (
    <div className="relative group">
      {leading && <div className="absolute left-1 top-1/2 z-10 -translate-y-1/2">{leading}</div>}
      <Link
        to={`/chat/${session.sessionId}`}
        className={cn(
          'block w-full text-left pr-8 rounded-lg transition-all duration-200 no-underline',
          compact ? 'py-1.5 pl-2' : 'p-2',
          leading && 'pl-7',
          isActive ? 'bg-surface-secondary' : 'hover:bg-surface-secondary',
          isNew && 'animate-subtle-fade-in'
        )}
      >
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'min-w-0 flex-1 leading-tight truncate',
              compact ? 'text-xs' : 'text-sm',
              compact || isSubAgent || isEventTriggered
                ? isActive
                  ? 'text-fg-secondary'
                  : 'text-fg-muted group-hover:text-fg-secondary'
                : isActive
                  ? 'text-fg-secondary'
                  : 'text-fg-secondary group-hover:text-fg-default'
            )}
          >
            {label ?? (
              <>
                {isEventTriggered && (
                  <span className="text-xs">{t('chat.sessionBadge.event')} </span>
                )}
                {isSubAgent && <span className="text-xs">{t('chat.sessionBadge.subAgent')} </span>}
                {session.title}
              </>
            )}
          </span>
          {trailing}
        </div>
      </Link>

      {/* More options button - visible on hover */}
      <button
        onClick={handleMenuClick}
        className={`
          absolute right-1 top-1/2 -translate-y-1/2 p-1 rounded
          text-fg-disabled hover:text-fg-secondary hover:bg-border
          transition-opacity duration-200
          ${isMenuOpen ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}
        `}
        title={t('common.moreOptions')}
      >
        <MoreHorizontal className="w-4 h-4" />
      </button>

      {/* Dropdown menu */}
      {isMenuOpen && (
        <div
          ref={menuRef}
          className="absolute right-0 top-full mt-1 bg-surface-primary rounded-lg shadow-lg border border-border py-1 z-50 min-w-[120px]"
        >
          <button
            onClick={handleDeleteClick}
            className="w-full px-3 py-2 text-left text-sm text-feedback-error hover:bg-feedback-error-bg flex items-center gap-2"
          >
            <Trash2 className="w-4 h-4" />
            {t('common.delete')}
          </button>
        </div>
      )}
    </div>
  );
});
