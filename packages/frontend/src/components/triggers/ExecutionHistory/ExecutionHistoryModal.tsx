/**
 * ExecutionHistoryModal Component
 *
 * Modal for displaying trigger execution history
 */

import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal, ModalHeader, ModalContent, ModalCloseButton } from '../../ui/Modal';
import { ExecutionList } from './ExecutionList';
import { getExecutionHistory } from '../../../api/triggers';
import type { ExecutionRecord } from '../../../types/trigger';
import toast from 'react-hot-toast';
import { logger } from '../../../utils/logger';

export interface ExecutionHistoryModalProps {
  /**
   * Whether the modal is open
   */
  isOpen: boolean;

  /**
   * Callback when modal is closed
   */
  onClose: () => void;

  /**
   * Trigger ID to show history for
   */
  triggerId: string;

  /**
   * Trigger name for display
   */
  triggerName: string;
}

export function ExecutionHistoryModal({
  isOpen,
  onClose,
  triggerId,
  triggerName,
}: ExecutionHistoryModalProps) {
  const { t } = useTranslation();
  const [executions, setExecutions] = useState<ExecutionRecord[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [nextToken, setNextToken] = useState<string | undefined>();

  // Paging load (triggered from onLoadMore). Kept as a useCallback because it
  // is only invoked from event handlers — never directly inside useEffect, so
  // react-hooks/set-state-in-effect does not apply.
  const loadMoreExecutions = useCallback(
    async (token: string) => {
      setIsLoading(true);

      try {
        const response = await getExecutionHistory(triggerId, undefined, token);
        setExecutions((prev) => [...prev, ...response.executions]);
        setNextToken(response.nextToken);
      } catch (error) {
        logger.error('Failed to load executions:', error);
        toast.error(t('triggers.messages.fetchError'));
      } finally {
        setIsLoading(false);
      }
    },
    [triggerId, t]
  );

  // Initial load when the modal opens. Inlined as an async IIFE with a
  // cancellation flag (React-docs "Fetching data" pattern) so state mutations
  // happen inside Promise resolution — not synchronously in the effect body —
  // satisfying react-hooks/set-state-in-effect.
  useEffect(() => {
    if (!isOpen || !triggerId) return;
    let cancelled = false;

    (async () => {
      if (cancelled) return;
      setIsLoading(true);

      try {
        const response = await getExecutionHistory(triggerId, undefined);
        if (cancelled) return;
        setExecutions(response.executions);
        setNextToken(response.nextToken);
      } catch (error) {
        if (cancelled) return;
        logger.error('Failed to load executions:', error);
        toast.error(t('triggers.messages.fetchError'));
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isOpen, triggerId, t]);

  const handleLoadMore = () => {
    if (nextToken && !isLoading) {
      loadMoreExecutions(nextToken);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="xl">
      <ModalHeader>
        <div>
          <h2 className="text-xl font-bold text-fg-default">{t('triggers.history.title')}</h2>
          <p className="text-sm text-fg-secondary mt-1">{triggerName}</p>
        </div>
        <ModalCloseButton />
      </ModalHeader>

      <ModalContent className="h-[600px] overflow-y-auto">
        <ExecutionList
          executions={executions}
          isLoading={isLoading}
          hasMore={!!nextToken}
          onLoadMore={handleLoadMore}
        />
      </ModalContent>
    </Modal>
  );
}
