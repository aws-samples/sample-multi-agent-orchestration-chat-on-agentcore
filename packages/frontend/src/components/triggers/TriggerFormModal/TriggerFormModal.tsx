/**
 * TriggerFormModal Component
 *
 * Modal for creating and editing triggers
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Settings, Clock } from 'lucide-react';
import {
  Modal,
  ModalHeader,
  ModalContent,
  ModalFooter,
  ModalTitle,
  ModalCloseButton,
} from '../../ui/Modal';
import { SidebarTabsLayout, type TabItem } from '../../ui/SidebarTabs';
import { TriggerBasicInfo } from './TriggerBasicInfo';
import { ScheduleConfig } from './ScheduleConfig';
import { InputMessageConfig } from './InputMessageConfig';
import { AgentExecutionConfig } from './AgentExecutionConfig';
import { EventTypeSelector, type EventType } from './EventTypeSelector';
import { EventSourceSelector } from './EventSourceSelector';
import { useTriggerStore } from '../../../stores/triggerStore';
import type { Trigger, CreateTriggerRequest, UpdateTriggerRequest } from '../../../types/trigger';
import type { AgentId, ReasoningDepth } from '@moca/core';
import { DEFAULT_MODEL_ID } from '../../../config/models';
import toast from 'react-hot-toast';
import { logger } from '../../../utils/logger';
import { ApiError } from '../../../types/errors';
import { validateScheduleInterval } from '../CronBuilder/cronUtils';

type TabType = 'basic' | 'trigger';

export interface TriggerFormModalProps {
  /**
   * Whether the modal is open
   */
  isOpen: boolean;

  /**
   * Callback when modal is closed
   */
  onClose: () => void;

  /**
   * Trigger to edit (null for create mode)
   */
  trigger?: Trigger | null;

  /**
   * Callback when trigger is saved
   */
  onSave?: () => void;
}

interface FormData {
  name: string;
  description: string;
  /**
   * Selected agent's ID. Branded as {@link AgentId} so it aligns with
   * {@link CreateTriggerRequest} / {@link UpdateTriggerRequest} without
   * an `as` cast at the request site. Empty string is modeled as the
   * "unselected" state (validated before submission).
   */
  agentId: AgentId | '';
  cronExpression: string;
  timezone: string;
  eventSourceId?: string;
  inputMessage: string;
  // Always set: new triggers default to DEFAULT_MODEL_ID, and legacy triggers
  // whose stored modelId is undefined also fall back to it (see
  // computeFormDataFromTrigger). The reasoning-depth selector keys off this.
  modelId: string;
  reasoningEffort?: ReasoningDepth;
  workingDirectory?: string;
}

/**
 * Normalize workingDirectory so the value persisted to DynamoDB is always a
 * mountable path. Empty string / whitespace-only / undefined all collapse to
 * `"/"`.
 *
 * Required because the Agent's workspace sync uses `if (body.storagePath)`,
 * which is falsy for `""`, leaving the workspace uninitialized at runtime.
 * The Trigger Lambda's `payload.workingDirectory ?? '/'` only catches
 * `null` / `undefined`, so an empty string would otherwise reach the Agent
 * unchanged. Normalizing at the only place new values enter persistence
 * keeps downstream code free of defensive fallbacks.
 */
function normalizeWorkingDirectory(value: string | undefined): string {
  if (typeof value !== 'string') return '/';
  const trimmed = value.trim();
  return trimmed === '' ? '/' : trimmed;
}

/**
 * Derive form data from the `trigger` prop. Used both to seed initial
 * useState and when the prop changes at runtime (via the "adjust state while
 * rendering" pattern below).
 */
function computeFormDataFromTrigger(trigger: Trigger | null | undefined): FormData {
  // Default to "/" so legacy triggers whose `workingDirectory` was persisted
  // as `undefined` or `""` (before save-time normalization existed) still
  // surface a valid path in the editor. New saves go through
  // `normalizeWorkingDirectory` in `handleSave`, so subsequent edits will
  // always see a normalized value here.
  if (trigger?.type === 'schedule' && trigger.scheduleConfig) {
    return {
      name: trigger.name,
      description: trigger.description || '',
      agentId: trigger.agentId,
      cronExpression: trigger.scheduleConfig.expression,
      timezone: trigger.scheduleConfig.timezone || 'Asia/Tokyo',
      inputMessage: trigger.prompt,
      modelId: trigger.modelId ?? DEFAULT_MODEL_ID,
      reasoningEffort: trigger.reasoningEffort,
      workingDirectory: trigger.workingDirectory ?? '/',
    };
  }
  if (trigger?.type === 'event' && trigger.eventConfig) {
    return {
      name: trigger.name,
      description: trigger.description || '',
      agentId: trigger.agentId,
      cronExpression: '0 0 * * ? *',
      timezone: 'Asia/Tokyo',
      eventSourceId: trigger.eventConfig.eventSourceId,
      inputMessage: trigger.prompt,
      modelId: trigger.modelId ?? DEFAULT_MODEL_ID,
      reasoningEffort: trigger.reasoningEffort,
      workingDirectory: trigger.workingDirectory ?? '/',
    };
  }
  return {
    name: '',
    description: '',
    agentId: '',
    cronExpression: '0 0 * * ? *',
    timezone: 'Asia/Tokyo',
    eventSourceId: undefined,
    inputMessage: '',
    modelId: DEFAULT_MODEL_ID,
    reasoningEffort: undefined,
    workingDirectory: '/',
  };
}

function computeEventTypeFromTrigger(trigger: Trigger | null | undefined): EventType | null {
  return trigger ? (trigger.type === 'event' ? 'event' : 'schedule') : null;
}

export function TriggerFormModal({ isOpen, onClose, trigger, onSave }: TriggerFormModalProps) {
  const { t } = useTranslation();
  const { createTrigger, updateTrigger } = useTriggerStore();
  const [isSaving, setIsSaving] = useState(false);
  const [activeTab, setActiveTab] = useState<TabType>('basic');
  const [selectedEventType, setSelectedEventType] = useState<EventType | null>(() =>
    computeEventTypeFromTrigger(trigger)
  );

  const isEditMode = !!trigger;

  // Initialize form data from the trigger prop.
  const [formData, setFormData] = useState<FormData>(() => computeFormDataFromTrigger(trigger));

  // Reset form when the `trigger` prop changes, or when the modal transitions
  // from closed to open. Tracking `isOpen` is required because the parent
  // ({@link EventsPage}) keeps `selectedTrigger` as `null` for consecutive
  // "create" actions — without the `isOpen` edge detection, reopening the
  // modal after a successful create would keep the previous form input.
  // Uses the React-recommended "adjusting state while rendering" pattern (see:
  // https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes)
  // instead of useEffect, so it satisfies react-hooks/set-state-in-effect and
  // avoids an extra render caused by the effect-then-setState roundtrip.
  const [prevTrigger, setPrevTrigger] = useState<Trigger | null | undefined>(trigger);
  const [prevIsOpen, setPrevIsOpen] = useState(isOpen);
  const triggerChanged = prevTrigger !== trigger;
  const justOpened = !prevIsOpen && isOpen;
  if (triggerChanged || justOpened) {
    setPrevTrigger(trigger);
    setPrevIsOpen(isOpen);
    setSelectedEventType(computeEventTypeFromTrigger(trigger));
    setFormData(computeFormDataFromTrigger(trigger));
  } else if (prevIsOpen !== isOpen) {
    setPrevIsOpen(isOpen);
  }

  // Validate form
  const validateForm = (): boolean => {
    if (!formData.name.trim()) {
      toast.error(t('triggers.form.nameRequired'));
      return false;
    }

    if (!formData.agentId) {
      toast.error(t('triggers.form.agentRequired'));
      return false;
    }

    if (!formData.inputMessage.trim()) {
      toast.error(t('triggers.form.inputMessageRequired'));
      return false;
    }

    if (selectedEventType === 'event' && !formData.eventSourceId) {
      toast.error(t('triggers.form.eventSourceRequired'));
      return false;
    }

    // Hard block: schedules under MINIMUM_INTERVAL_MINUTES (10 min) must never
    // be created. This protects the `GetOpenIdTokenForDeveloperIdentity`
    // 25 TPS hard quota when multiple users schedule similar crons, and bounds
    // the per-fire Lambda/Bedrock cost of high-frequency schedules. The
    // backend enforces the same rule in `scheduler-service.ts`; the UI check
    // is purely for immediate feedback.
    if (selectedEventType === 'schedule') {
      const intervalClass = validateScheduleInterval(formData.cronExpression);
      if (intervalClass === 'too-short') {
        toast.error(t('triggers.cron.intervalTooShort'));
        return false;
      }
    }

    return true;
  };

  /**
   * Ask explicit confirmation when the user is about to create a schedule
   * with a shorter-than-hourly cadence. `window.confirm` is deliberately used
   * here because it is modal and synchronous — easier to reason about than
   * introducing an additional in-page confirmation modal for an edge case.
   * Returns `true` if the user confirmed (or no warning applies) and the
   * submit flow should continue.
   */
  const confirmShortIntervalIfNeeded = (): boolean => {
    if (selectedEventType !== 'schedule') return true;
    const intervalClass = validateScheduleInterval(formData.cronExpression);
    if (intervalClass !== 'warning' && intervalClass !== 'unknown') return true;
    const title = t('triggers.cron.costWarning.title');
    const body = t('triggers.cron.costWarning.body');
    return window.confirm(`${title}\n\n${body}`);
  };

  // Handle save
  const handleSave = async () => {
    if (!validateForm()) {
      return;
    }

    if (!confirmShortIntervalIfNeeded()) {
      return;
    }

    setIsSaving(true);

    try {
      // WHY the assertion: `validateForm()` above guarantees a non-empty
      // `agentId`, so the `''` state has been excluded at this point.
      const selectedAgentId = formData.agentId as AgentId;

      // Always persist a mountable workingDirectory. See
      // `normalizeWorkingDirectory` for the full rationale.
      const workingDirectory = normalizeWorkingDirectory(formData.workingDirectory);

      if (isEditMode) {
        // Update existing trigger
        const updateData: UpdateTriggerRequest = {
          name: formData.name,
          description: formData.description || undefined,
          agentId: selectedAgentId,
          type: selectedEventType as 'schedule' | 'event',
          prompt: formData.inputMessage,
          modelId: formData.modelId,
          reasoningEffort: formData.reasoningEffort,
          workingDirectory,
        };

        if (selectedEventType === 'schedule') {
          updateData.scheduleConfig = {
            expression: formData.cronExpression,
            timezone: formData.timezone,
          };
        } else if (selectedEventType === 'event') {
          updateData.eventConfig = {
            eventSourceId: formData.eventSourceId!,
          };
        }

        await updateTrigger(trigger.id, updateData);
        toast.success(t('triggers.messages.updateSuccess'));
      } else {
        // Create new trigger
        const createData: CreateTriggerRequest = {
          name: formData.name,
          description: formData.description || undefined,
          agentId: selectedAgentId,
          type: selectedEventType as 'schedule' | 'event',
          prompt: formData.inputMessage,
          modelId: formData.modelId,
          reasoningEffort: formData.reasoningEffort,
          workingDirectory,
        };

        if (selectedEventType === 'schedule') {
          createData.scheduleConfig = {
            expression: formData.cronExpression,
            timezone: formData.timezone,
          };
        } else if (selectedEventType === 'event') {
          createData.eventConfig = {
            eventSourceId: formData.eventSourceId!,
          };
        }

        await createTrigger(createData);
        toast.success(t('triggers.messages.createSuccess'));
      }

      onSave?.();
      onClose();
    } catch (error) {
      logger.error('Failed to save trigger:', error);
      // Surface the per-user trigger-limit (HTTP 409) with a specific message
      // so the user understands creation was rejected by the cap, not a bug.
      if (!isEditMode && error instanceof ApiError && error.status === 409) {
        const limit = (error.details as { limit?: number } | undefined)?.limit;
        toast.error(t('triggers.messages.limitExceeded', { limit }));
      } else {
        toast.error(
          isEditMode ? t('triggers.messages.updateError') : t('triggers.messages.createError')
        );
      }
    } finally {
      setIsSaving(false);
    }
  };

  // Handle cancel
  const handleCancel = () => {
    onClose();
  };

  // Tab configuration
  const tabs: TabItem<TabType>[] = [
    { id: 'basic', label: t('triggers.tabs.basic'), icon: Settings },
    { id: 'trigger', label: t('triggers.tabs.trigger'), icon: Clock },
  ];

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="xl">
      <ModalHeader>
        <ModalTitle>
          {isEditMode ? t('triggers.form.editTitle') : t('triggers.form.createTitle')}
        </ModalTitle>
        <ModalCloseButton />
      </ModalHeader>

      <ModalContent noPadding={true}>
        <SidebarTabsLayout tabs={tabs} activeTab={activeTab} onTabChange={setActiveTab}>
          <div className="h-[80vh] overflow-y-auto px-6 py-6">
            {/* Basic Settings Tab */}
            {activeTab === 'basic' && (
              <div className="space-y-6 max-w-5xl mx-auto">
                <h2 className="text-lg font-semibold text-fg-default mb-6">
                  {t('triggers.tabs.basic')}
                </h2>

                {/* Basic Info */}
                <TriggerBasicInfo
                  name={formData.name}
                  description={formData.description}
                  agentId={formData.agentId}
                  onNameChange={(name: string) => setFormData({ ...formData, name })}
                  onDescriptionChange={(description: string) =>
                    setFormData({ ...formData, description })
                  }
                  onAgentIdChange={(agentId) => setFormData({ ...formData, agentId })}
                  disabled={isSaving}
                />

                {/* Agent Execution Config */}
                <AgentExecutionConfig
                  modelId={formData.modelId}
                  workingDirectory={formData.workingDirectory}
                  reasoningEffort={formData.reasoningEffort}
                  onModelIdChange={(modelId) => setFormData({ ...formData, modelId })}
                  onReasoningEffortChange={(reasoningEffort) =>
                    setFormData({ ...formData, reasoningEffort })
                  }
                  onWorkingDirectoryChange={(workingDirectory) =>
                    setFormData({ ...formData, workingDirectory })
                  }
                  disabled={isSaving}
                />

                {/* Input Message */}
                <InputMessageConfig
                  inputMessage={formData.inputMessage}
                  onChange={(inputMessage: string) => setFormData({ ...formData, inputMessage })}
                  disabled={isSaving}
                />
              </div>
            )}

            {/* Trigger Configuration Tab */}
            {activeTab === 'trigger' && (
              <div className="space-y-6 max-w-5xl mx-auto">
                <h2 className="text-lg font-semibold text-fg-default mb-6">
                  {t('triggers.tabs.trigger')}
                </h2>

                {/* Event Type Selector */}
                <EventTypeSelector
                  selectedType={selectedEventType}
                  onSelect={setSelectedEventType}
                  disabled={isSaving}
                />

                {/* Event Type Configuration */}
                {selectedEventType === 'schedule' && (
                  <ScheduleConfig
                    cronExpression={formData.cronExpression}
                    timezone={formData.timezone}
                    onCronChange={(cronExpression: string) =>
                      setFormData({ ...formData, cronExpression })
                    }
                    onTimezoneChange={(timezone: string) => setFormData({ ...formData, timezone })}
                    disabled={isSaving}
                  />
                )}

                {selectedEventType === 'event' && (
                  <EventSourceSelector
                    value={formData.eventSourceId}
                    onChange={(eventSourceId: string) =>
                      setFormData({ ...formData, eventSourceId })
                    }
                    disabled={isSaving}
                  />
                )}
              </div>
            )}
          </div>
        </SidebarTabsLayout>
      </ModalContent>

      <ModalFooter>
        <div className="flex justify-end gap-3">
          <button
            type="button"
            onClick={handleCancel}
            disabled={isSaving}
            className="px-5 py-2.5 text-sm font-medium text-fg-secondary bg-surface-secondary rounded-xl hover:bg-border active:scale-95 transition-all disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100 shadow-sm"
          >
            {t('triggers.form.cancel')}
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={isSaving}
            className="px-5 py-2.5 text-sm font-medium text-white bg-action-primary rounded-xl hover:bg-action-primary-hover active:scale-95 transition-all disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100 shadow-sm flex items-center gap-2"
          >
            {isSaving && (
              <svg
                className="animate-spin h-4 w-4"
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                />
              </svg>
            )}
            {isSaving ? t('triggers.form.saving') : t('triggers.form.save')}
          </button>
        </div>
      </ModalFooter>
    </Modal>
  );
}
