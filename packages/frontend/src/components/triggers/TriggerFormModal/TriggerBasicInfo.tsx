/**
 * TriggerBasicInfo Component
 *
 * Basic information input for trigger (name, description, agent selection)
 */

import { useTranslation } from 'react-i18next';
import { useAgentStore } from '../../../stores/agentStore';
import type { AgentId } from '@moca/core';

export interface TriggerBasicInfoProps {
  name: string;
  description: string;
  /**
   * Selected agent's branded `AgentId`, or `''` when no agent is selected yet.
   * Modeling the empty state as `''` matches the `<option value="">` placeholder
   * in the `<select>` below without widening to unbranded `string`.
   */
  agentId: AgentId | '';
  onNameChange: (name: string) => void;
  onDescriptionChange: (description: string) => void;
  /**
   * Called with either the branded id of the selected agent (drawn from
   * `agents[].agentId` which is already `AgentId`) or `''` for the placeholder
   * option. The union preserves the brand along the entire callback path.
   */
  onAgentIdChange: (agentId: AgentId | '') => void;
  disabled?: boolean;
}

export function TriggerBasicInfo({
  name,
  description,
  agentId,
  onNameChange,
  onDescriptionChange,
  onAgentIdChange,
  disabled = false,
}: TriggerBasicInfoProps) {
  const { t } = useTranslation();
  const { agents } = useAgentStore();

  // Get display name for agent (translate if it's a translation key)
  const getAgentDisplayName = (agentName: string) => {
    // If name starts with 'defaultAgents.', it's a translation key
    if (agentName.startsWith('defaultAgents.')) {
      return t(agentName);
    }
    return agentName;
  };

  return (
    <div>
      <div className="mb-4">
        <h3 className="text-base font-semibold text-fg-default">{t('triggers.form.basicInfo')}</h3>
        <p className="text-sm text-fg-muted mt-1">{t('triggers.form.basicInfoDescription')}</p>
      </div>

      <div className="space-y-4">
        {/* Trigger Name */}
        <div>
          <label className="block text-sm font-medium text-fg-secondary mb-2">
            {t('triggers.form.name')} <span className="text-feedback-error">*</span>
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => onNameChange(e.target.value)}
            placeholder={t('triggers.form.namePlaceholder')}
            disabled={disabled}
            maxLength={100}
            className="w-full px-3 py-2 bg-surface-primary border border-border-strong rounded-lg focus:outline-none focus:ring-2 focus:ring-border-focus disabled:bg-surface-secondary disabled:cursor-not-allowed"
          />
        </div>

        {/* Agent Selection */}
        <div>
          <label className="block text-sm font-medium text-fg-secondary mb-2">
            {t('triggers.form.agent')} <span className="text-feedback-error">*</span>
          </label>
          <select
            value={agentId}
            // WHY the cast: HTML `<select>` always yields a plain string, but
            // every non-placeholder option value comes from `agent.agentId`
            // (already branded `AgentId`), so the runtime value is guaranteed
            // to satisfy the callback's `AgentId | ''` contract.
            onChange={(e) => onAgentIdChange(e.target.value as AgentId | '')}
            disabled={disabled}
            className="w-full px-3 py-2 bg-surface-primary border border-border-strong rounded-lg focus:outline-none focus:ring-2 focus:ring-border-focus disabled:bg-surface-secondary disabled:cursor-not-allowed"
          >
            <option value="">{t('triggers.form.agentPlaceholder')}</option>
            {agents.map((agent) => (
              <option key={agent.agentId} value={agent.agentId}>
                {getAgentDisplayName(agent.name)}
              </option>
            ))}
          </select>
          {agents.length === 0 && (
            <p className="mt-2 text-sm text-fg-muted">{t('agent.noAgents')}</p>
          )}
        </div>

        {/* Description - Full width */}
        <div>
          <label className="block text-sm font-medium text-fg-secondary mb-2">
            {t('triggers.form.description')}
          </label>
          <textarea
            value={description}
            onChange={(e) => onDescriptionChange(e.target.value)}
            placeholder={t('triggers.form.descriptionPlaceholder')}
            disabled={disabled}
            maxLength={500}
            rows={3}
            className="w-full px-3 py-2 bg-surface-primary border border-border-strong rounded-lg focus:outline-none focus:ring-2 focus:ring-border-focus resize-none disabled:bg-surface-secondary disabled:cursor-not-allowed"
          />
        </div>
      </div>
    </div>
  );
}
