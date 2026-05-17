/**
 * EventTypeSelector Component
 *
 * Card-based selector for trigger event types
 */

import { useTranslation } from 'react-i18next';
import { Clock, Zap } from 'lucide-react';
import toast from 'react-hot-toast';

export type EventType = 'schedule' | 'event';

interface EventTypeOption {
  id: EventType;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  description: string;
  isAvailable: boolean;
}

export interface EventTypeSelectorProps {
  selectedType: EventType | null;
  onSelect: (type: EventType | null) => void;
  disabled?: boolean;
}

export function EventTypeSelector({
  selectedType,
  onSelect,
  disabled = false,
}: EventTypeSelectorProps) {
  const { t } = useTranslation();

  const eventTypes: EventTypeOption[] = [
    {
      id: 'schedule',
      icon: Clock,
      label: t('triggers.eventTypes.schedule.label'),
      description: t('triggers.eventTypes.schedule.description'),
      isAvailable: true,
    },
    {
      id: 'event',
      icon: Zap,
      label: t('triggers.eventTypes.event.label'),
      description: t('triggers.eventTypes.event.description'),
      isAvailable: true,
    },
  ];

  const handleSelect = (type: EventType, isAvailable: boolean) => {
    if (disabled) return;

    if (!isAvailable) {
      toast(t('triggers.eventTypes.comingSoon'), { icon: 'ℹ️' });
      return;
    }

    onSelect(type);
  };

  // If a type is already selected, show change button
  if (selectedType) {
    const selected = eventTypes.find((t) => t.id === selectedType);
    if (!selected) return null;

    const Icon = selected.icon;

    return (
      <div>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-medium text-fg-secondary">
            {t('triggers.eventTypes.title')}
          </h3>
          <button
            type="button"
            onClick={() => onSelect(null)}
            disabled={disabled}
            className="text-sm text-action-primary hover:text-action-primary font-medium disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {t('triggers.eventTypes.change')}
          </button>
        </div>

        <div className="flex items-center gap-3 p-3 bg-surface-secondary border border-border rounded-lg">
          <div className="flex-shrink-0">
            <div className="w-8 h-8 bg-gray-600 rounded-lg flex items-center justify-center">
              <Icon className="w-4 h-4 text-white" />
            </div>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-fg-default">{selected.label}</p>
          </div>
        </div>
      </div>
    );
  }

  // Show selection cards
  return (
    <div>
      <div className="mb-4">
        <h3 className="text-base font-semibold text-fg-default">
          {t('triggers.eventTypes.selectTitle')}
        </h3>
        <p className="text-sm text-fg-muted mt-1">{t('triggers.eventTypes.selectDescription')}</p>
      </div>

      <div className="grid grid-cols-1 gap-3">
        {eventTypes.map((eventType) => {
          const Icon = eventType.icon;
          const isDisabled = disabled || !eventType.isAvailable;

          return (
            <button
              key={eventType.id}
              type="button"
              onClick={() => handleSelect(eventType.id, eventType.isAvailable)}
              disabled={isDisabled}
              className={`
                relative flex items-center gap-3 p-4 text-left
                border rounded-lg transition-all
                ${
                  eventType.isAvailable
                    ? 'border-border-strong hover:border-blue-500 hover:bg-feedback-info-bg active:scale-[0.98]'
                    : 'border-border bg-surface-secondary'
                }
                ${isDisabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}
              `}
            >
              {/* Icon */}
              <div
                className={`flex-shrink-0 w-12 h-12 rounded-lg flex items-center justify-center ${
                  eventType.isAvailable ? 'bg-action-primary' : 'bg-gray-400'
                }`}
              >
                <Icon className="w-6 h-6 text-white" />
              </div>

              {/* Content */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-semibold text-fg-default">{eventType.label}</p>
                  {!eventType.isAvailable && (
                    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-border text-fg-secondary">
                      {t('triggers.eventTypes.comingSoonBadge')}
                    </span>
                  )}
                </div>
                <p className="text-xs text-fg-secondary mt-1">{eventType.description}</p>
              </div>

              {/* Arrow indicator for available types */}
              {eventType.isAvailable && (
                <div className="flex-shrink-0">
                  <svg
                    className="w-5 h-5 text-fg-disabled"
                    fill="none"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path d="M9 5l7 7-7 7" />
                  </svg>
                </div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
