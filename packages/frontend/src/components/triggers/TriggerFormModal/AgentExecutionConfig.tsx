/**
 * AgentExecutionConfig Component
 * Configuration for agent execution settings (model + reasoning depth, working directory)
 */

import { useTranslation } from 'react-i18next';
import type { ReasoningDepth } from '@moca/core';
import { FolderPathSelector } from '../../ui/FolderPathSelector';
import { ModelReasoningSelector } from '../../ui/ModelReasoningSelector';

export interface AgentExecutionConfigProps {
  /** Required: the form always initializes this to DEFAULT_MODEL_ID. */
  modelId: string;
  workingDirectory?: string;
  reasoningEffort?: ReasoningDepth;
  onModelIdChange: (modelId: string) => void;
  onReasoningEffortChange: (depth: ReasoningDepth) => void;
  onWorkingDirectoryChange: (path: string | undefined) => void;
  disabled?: boolean;
}

export function AgentExecutionConfig({
  modelId,
  workingDirectory,
  reasoningEffort,
  onModelIdChange,
  onReasoningEffortChange,
  onWorkingDirectoryChange,
  disabled = false,
}: AgentExecutionConfigProps) {
  const { t } = useTranslation();

  return (
    <div className="space-y-4">
      {/* Model + reasoning depth (combined selector, opens downward in the modal) */}
      <div>
        <label className="block text-sm font-medium text-fg-secondary mb-2">
          {t('triggers.form.modelId')}
        </label>
        <ModelReasoningSelector
          modelId={modelId}
          reasoningEffort={reasoningEffort}
          onModelChange={onModelIdChange}
          onReasoningEffortChange={onReasoningEffortChange}
          position="bottom"
          disabled={disabled}
        />
        <p className="text-xs text-fg-muted mt-1">{t('triggers.form.modelIdHint')}</p>
      </div>

      {/* Working Directory Selection */}
      <div>
        <label className="block text-sm font-medium text-fg-secondary mb-2">
          {t('triggers.form.workingDirectory')}
          <span className="text-fg-disabled ml-1 text-xs">({t('triggers.form.optional')})</span>
        </label>
        <FolderPathSelector
          value={workingDirectory}
          onChange={onWorkingDirectoryChange}
          disabled={disabled}
        />
        <p className="text-xs text-fg-muted mt-1">{t('triggers.form.workingDirectoryHint')}</p>
      </div>
    </div>
  );
}
