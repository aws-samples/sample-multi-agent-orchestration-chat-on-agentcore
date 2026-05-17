/**
 * Events Page - Trigger Management
 * Manage scheduled agent executions
 */

import { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { CalendarRange, CalendarPlus } from 'lucide-react';
import { PageHeader } from '../components/ui/PageHeader';
import { Button, IconButton } from '../components/ui/Button';
import { TriggerList } from '../components/triggers/TriggerList';
import { TriggerFormModal } from '../components/triggers/TriggerFormModal';
import { ExecutionHistoryModal } from '../components/triggers/ExecutionHistory';
import { useTriggerStore } from '../stores/triggerStore';
import { useUIStore } from '../stores/uiStore';
import type { Trigger } from '../types/trigger';
import toast from 'react-hot-toast';
import { logger } from '../utils/logger';

export function EventsPage() {
  const { t } = useTranslation();
  const { triggers, isLoading, fetchTriggers, setTriggerEnabled, deleteTrigger } =
    useTriggerStore();
  const { setMobileHeaderAction } = useUIStore();

  // Modal states
  const [isFormModalOpen, setIsFormModalOpen] = useState(false);
  const [isHistoryModalOpen, setIsHistoryModalOpen] = useState(false);
  const [selectedTrigger, setSelectedTrigger] = useState<Trigger | null>(null);
  const [historyTriggerId, setHistoryTriggerId] = useState<string>('');
  const [historyTriggerName, setHistoryTriggerName] = useState<string>('');

  // Handle create trigger - memoized to prevent infinite loop in useEffect
  const handleCreate = useCallback(() => {
    setSelectedTrigger(null);
    setIsFormModalOpen(true);
  }, []);

  // Fetch triggers on mount
  useEffect(() => {
    fetchTriggers().catch((error) => {
      logger.error('Failed to fetch triggers:', error);
      toast.error(t('triggers.messages.fetchError'));
    });
  }, [fetchTriggers, t]);

  // Set mobile header action on mount, clear on unmount
  useEffect(() => {
    setMobileHeaderAction(
      <IconButton icon={CalendarPlus} label={t('triggers.create')} onClick={handleCreate} />
    );

    // Cleanup: clear mobile header action when leaving the page
    return () => {
      setMobileHeaderAction(null);
    };
  }, [setMobileHeaderAction, t, handleCreate]);

  // Handle toggle trigger
  const handleToggle = async (triggerId: string, enabled: boolean) => {
    try {
      await setTriggerEnabled(triggerId, enabled);
      const messageKey = enabled
        ? 'triggers.messages.enableSuccess'
        : 'triggers.messages.disableSuccess';
      toast.success(t(messageKey));
    } catch (error) {
      logger.error('Failed to toggle trigger:', error);
      // Error is already handled by store with rollback
    }
  };

  // Handle delete trigger
  const handleDelete = async (triggerId: string) => {
    if (!confirm(t('triggers.messages.deleteConfirm'))) {
      return;
    }

    try {
      await deleteTrigger(triggerId);
      toast.success(t('triggers.messages.deleteSuccess'));
    } catch (error) {
      logger.error('Failed to delete trigger:', error);
      toast.error(t('triggers.messages.deleteError'));
    }
  };

  // Handle edit trigger
  const handleEdit = (trigger: Trigger) => {
    setSelectedTrigger(trigger);
    setIsFormModalOpen(true);
  };

  // Handle view history
  const handleViewHistory = (triggerId: string) => {
    const trigger = triggers.find((t) => t.id === triggerId);
    if (trigger) {
      setHistoryTriggerId(triggerId);
      setHistoryTriggerName(trigger.name);
      setIsHistoryModalOpen(true);
    }
  };

  // Handle form modal close
  const handleFormModalClose = () => {
    setIsFormModalOpen(false);
    setSelectedTrigger(null);
  };

  // Handle form save
  const handleFormSave = () => {
    fetchTriggers();
  };

  // Handle history modal close
  const handleHistoryModalClose = () => {
    setIsHistoryModalOpen(false);
    setHistoryTriggerId('');
    setHistoryTriggerName('');
  };

  return (
    <>
      <PageHeader
        icon={CalendarRange}
        title={t('navigation.events')}
        actions={
          <>
            <Button
              variant="ghost"
              size="md"
              leftIcon={CalendarPlus}
              onClick={handleCreate}
              className="hidden md:inline-flex"
            >
              {t('triggers.create')}
            </Button>
            <IconButton
              icon={CalendarPlus}
              label={t('triggers.create')}
              onClick={handleCreate}
              className="md:hidden"
            />
          </>
        }
      />

      {/* Main Content */}
      <div className="flex-1 overflow-y-auto p-6">
        {/* Description Section */}
        <div className="mb-section">
          <p className="text-sm text-fg-secondary leading-relaxed">
            {t('triggers.pageDescription')}
          </p>
        </div>

        <TriggerList
          triggers={triggers}
          isLoading={isLoading}
          onEdit={handleEdit}
          onToggle={handleToggle}
          onViewHistory={handleViewHistory}
          onDelete={handleDelete}
        />
      </div>

      {/* Modals */}
      <TriggerFormModal
        isOpen={isFormModalOpen}
        onClose={handleFormModalClose}
        trigger={selectedTrigger}
        onSave={handleFormSave}
      />

      <ExecutionHistoryModal
        isOpen={isHistoryModalOpen}
        onClose={handleHistoryModalClose}
        triggerId={historyTriggerId}
        triggerName={historyTriggerName}
      />
    </>
  );
}
