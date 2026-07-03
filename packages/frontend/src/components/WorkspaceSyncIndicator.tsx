import React from 'react';
import { useTranslation } from 'react-i18next';
import type { WorkspaceSyncState } from '../types/index';

interface WorkspaceSyncIndicatorProps {
  state: WorkspaceSyncState;
}

/**
 * Ephemeral status line shown next to the storage-path folder above the chat
 * input while the agent's workspace performs its initial S3→local pull. Only
 * rendered when the pull is slow enough for the backend to have announced it
 * (see the agent stream-handler debounce), so this component never needs its
 * own flash-prevention logic.
 *
 * Text only — no icon or animation. Renders three states: syncing (with
 * optional count/percent), complete (briefly, then auto-dismissed by the
 * store), and error. Designed to sit inline in a flex row, so it carries no
 * vertical padding of its own.
 */
export const WorkspaceSyncIndicator: React.FC<WorkspaceSyncIndicatorProps> = ({ state }) => {
  const { t } = useTranslation();

  if (state.status === 'error') {
    return (
      <span className="text-sm text-feedback-error">
        {t('workspaceSync.error', { message: state.message ?? '' })}
      </span>
    );
  }

  if (state.status === 'complete') {
    return <span className="text-sm text-fg-muted">{t('workspaceSync.complete')}</span>;
  }

  // status === 'syncing'
  // A total of 0 means the backend has started the pull but hasn't counted files
  // yet — show a generic "preparing" message rather than "0/0".
  const hasCount = (state.total ?? 0) > 0;
  const label = hasCount
    ? t('workspaceSync.syncingProgress', {
        current: state.current ?? 0,
        total: state.total ?? 0,
        percentage: state.percentage ?? 0,
      })
    : t('workspaceSync.preparing');

  return <span className="text-sm text-fg-muted">{label}</span>;
};
