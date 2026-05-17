/**
 * TriggerCard Component
 * Displays individual trigger information with action buttons
 */

import { Clock, Bot, Calendar, Edit, Trash2, History, Zap, Bell } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useState, useEffect } from 'react';
import type { Trigger, ScheduleConfig, EventConfig } from '../../types/trigger';
import { useAgentStore } from '../../stores/agentStore';
import { useTriggerStore } from '../../stores/triggerStore';
import { translateIfKey } from '../../utils/agent-translation';
import { getEventSources } from '../../api/events';
import { Button } from '../ui/Button';
import { Toggle } from '../ui/Toggle';
import { Card } from '../ui/Card';
import { logger } from '../../utils/logger';

interface TriggerCardProps {
  trigger: Trigger;
  onEdit: (trigger: Trigger) => void;
  onToggle: (triggerId: string, enabled: boolean) => void;
  onViewHistory: (triggerId: string) => void;
  onDelete: (triggerId: string) => void;
}

export function TriggerCard({
  trigger,
  onEdit,
  onToggle,
  onViewHistory,
  onDelete,
}: TriggerCardProps) {
  const { t } = useTranslation();
  const { getAgent } = useAgentStore();
  const togglingIds = useTriggerStore((state) => state.togglingIds);
  const agent = getAgent(trigger.agentId);
  const isEnabled = trigger.enabled;
  const isToggling = togglingIds.has(trigger.id);
  const scheduleConfig = trigger.scheduleConfig as ScheduleConfig;
  const eventConfig = trigger.eventConfig as EventConfig;

  // Fetch event source information for event-type triggers
  const [eventSourceName, setEventSourceName] = useState<string>('');

  useEffect(() => {
    if (trigger.type === 'event' && eventConfig?.eventSourceId) {
      getEventSources()
        .then((sources) => {
          const source = sources.find((s) => s.id === eventConfig.eventSourceId);
          if (source) {
            setEventSourceName(source.name);
          }
        })
        .catch((err) => {
          logger.error('Failed to fetch event sources:', err);
        });
    }
  }, [trigger.type, eventConfig?.eventSourceId]);

  // Format last execution time
  const formatLastExecution = (timestamp?: string) => {
    if (!timestamp) return t('triggers.card.notExecuted');
    const date = new Date(timestamp);
    return date.toLocaleString('ja-JP', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  return (
    <Card
      variant="default"
      padding="lg"
      className="flex flex-col h-full hover:shadow-elevation-2 transition-shadow"
    >
      {/* Header with Toggle */}
      <div className="flex items-start justify-between mb-4">
        <div className="flex-1 min-w-0 pr-4">
          <h3 className="text-lg font-semibold text-fg-default truncate mb-2">{trigger.name}</h3>
          {trigger.description && (
            <p className="text-sm text-fg-secondary line-clamp-2">{trigger.description}</p>
          )}
        </div>

        {/* Toggle Switch */}
        <div className="flex-shrink-0">
          <Toggle
            checked={isEnabled}
            onChange={(checked) => onToggle(trigger.id, checked)}
            loading={isToggling}
            label={isEnabled ? t('triggers.card.enabled') : t('triggers.card.disabled')}
          />
        </div>
      </div>

      {/* Trigger Info - Type-specific display */}
      <div className="space-y-2 mb-4 flex-1">
        {trigger.type === 'schedule' ? (
          <>
            {/* Schedule Type */}
            <div className="flex items-center gap-2 text-sm text-fg-secondary">
              <Clock className="w-4 h-4 text-fg-disabled flex-shrink-0" />
              <span className="font-medium">{t('triggers.card.schedule')}:</span>
              <span className="truncate">{scheduleConfig?.expression || 'N/A'}</span>
            </div>

            <div className="flex items-center gap-2 text-sm text-fg-secondary">
              <Calendar className="w-4 h-4 text-fg-disabled flex-shrink-0" />
              <span className="font-medium">{t('triggers.card.timezone')}:</span>
              <span className="truncate">{scheduleConfig?.timezone || 'N/A'}</span>
            </div>
          </>
        ) : (
          <>
            {/* Event Type */}
            <div className="flex items-center gap-2 text-sm text-fg-secondary">
              <Zap className="w-4 h-4 text-fg-disabled flex-shrink-0" />
              <span className="font-medium">{t('triggers.card.eventSource')}:</span>
              <span className="truncate">
                {eventSourceName || eventConfig?.eventSourceId || 'N/A'}
              </span>
            </div>

            <div className="flex items-center gap-2 text-sm text-fg-secondary">
              <Bell className="w-4 h-4 text-fg-disabled flex-shrink-0" />
              <span className="font-medium">{t('triggers.card.triggerCondition')}:</span>
              <span className="truncate">{t('triggers.card.onEventReceived')}</span>
            </div>
          </>
        )}

        {/* Common: Agent */}
        <div className="flex items-center gap-2 text-sm text-fg-secondary">
          <Bot className="w-4 h-4 text-fg-disabled flex-shrink-0" />
          <span className="font-medium">{t('triggers.card.agent')}:</span>
          <span className="truncate">
            {agent ? translateIfKey(agent.name, t) : trigger.agentId}
          </span>
        </div>
      </div>

      {/* Last Execution */}
      {trigger.lastExecutedAt && (
        <div className="mb-4 p-3 bg-surface-secondary rounded-lg">
          <p className="text-xs text-fg-secondary">
            {t('triggers.card.lastExecution')}: {formatLastExecution(trigger.lastExecutedAt)}
          </p>
        </div>
      )}

      {/* Action Buttons */}
      <div className="flex items-center gap-2 pt-4 border-t border-border">
        <Button
          variant="outline"
          size="sm"
          leftIcon={Edit}
          onClick={() => onEdit(trigger)}
          className="flex-1 lg:flex-initial"
        >
          <span className="hidden lg:inline">{t('triggers.edit')}</span>
        </Button>

        <Button
          variant="outline"
          size="sm"
          leftIcon={History}
          onClick={() => onViewHistory(trigger.id)}
          className="flex-1 lg:flex-initial"
        >
          <span className="hidden lg:inline">{t('triggers.viewHistory')}</span>
        </Button>

        <Button
          variant="danger"
          size="sm"
          leftIcon={Trash2}
          onClick={() => onDelete(trigger.id)}
          className="flex-1 lg:flex-initial lg:ml-auto"
        >
          <span className="hidden lg:inline">{t('triggers.delete')}</span>
        </Button>
      </div>
    </Card>
  );
}
