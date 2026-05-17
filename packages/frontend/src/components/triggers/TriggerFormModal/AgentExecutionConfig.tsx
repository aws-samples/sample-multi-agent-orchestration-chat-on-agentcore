/**
 * AgentExecutionConfig Component
 * Configuration for agent execution settings (model ID and working directory)
 */

import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, Sparkles } from 'lucide-react';
import { AVAILABLE_MODELS, getModelById } from '../../../config/models';
import { FolderPathSelector } from '../../ui/FolderPathSelector';

export interface AgentExecutionConfigProps {
  modelId?: string;
  workingDirectory?: string;
  onModelIdChange: (modelId: string | undefined) => void;
  onWorkingDirectoryChange: (path: string | undefined) => void;
  disabled?: boolean;
}

export function AgentExecutionConfig({
  modelId,
  workingDirectory,
  onModelIdChange,
  onWorkingDirectoryChange,
  disabled = false,
}: AgentExecutionConfigProps) {
  const { t } = useTranslation();
  const [isModelSelectorOpen, setIsModelSelectorOpen] = useState(false);
  const modelDropdownRef = useRef<HTMLDivElement>(null);

  const selectedModel = modelId ? getModelById(modelId) : null;

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (modelDropdownRef.current && !modelDropdownRef.current.contains(event.target as Node)) {
        setIsModelSelectorOpen(false);
      }
    };

    if (isModelSelectorOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isModelSelectorOpen]);

  const handleModelSelect = (selectedModelId: string) => {
    onModelIdChange(selectedModelId);
    setIsModelSelectorOpen(false);
  };

  const handleClearModel = () => {
    onModelIdChange(undefined);
    setIsModelSelectorOpen(false);
  };

  return (
    <div className="space-y-4">
      {/* Model Selection */}
      <div>
        <label className="block text-sm font-medium text-fg-secondary mb-2">
          {t('triggers.form.modelId')}
          <span className="text-fg-disabled ml-1 text-xs">({t('triggers.form.optional')})</span>
        </label>
        <div ref={modelDropdownRef} className="relative">
          <button
            type="button"
            onClick={() => !disabled && setIsModelSelectorOpen(!isModelSelectorOpen)}
            disabled={disabled}
            className="w-full flex items-center justify-between gap-2 px-3 py-2 text-sm text-fg-default bg-surface-primary border border-border-strong rounded-lg hover:bg-surface-secondary disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <div className="flex items-center gap-2 flex-1 min-w-0">
              <Sparkles className="w-4 h-4 text-fg-disabled flex-shrink-0" />
              {selectedModel ? (
                <div className="flex items-center gap-2 min-w-0">
                  <span className="font-medium truncate">{selectedModel.name}</span>
                  <span className="text-fg-disabled text-xs truncate">
                    ({selectedModel.provider})
                  </span>
                </div>
              ) : (
                <span className="text-fg-disabled">{t('triggers.form.selectModel')}</span>
              )}
            </div>
            <ChevronDown
              className={`w-4 h-4 text-fg-disabled transition-transform flex-shrink-0 ${
                isModelSelectorOpen ? 'rotate-180' : ''
              }`}
            />
          </button>

          {isModelSelectorOpen && (
            <div className="absolute top-full left-0 right-0 mt-1 bg-surface-primary rounded-lg shadow-lg border border-border py-1 z-50 max-h-64 overflow-y-auto">
              <button
                type="button"
                onClick={handleClearModel}
                className="w-full px-3 py-2 text-left text-sm hover:bg-surface-secondary transition-colors text-fg-muted"
              >
                {t('triggers.form.useDefault')}
              </button>
              <div className="border-t border-border my-1" />
              {AVAILABLE_MODELS.map((model) => (
                <button
                  key={model.id}
                  type="button"
                  onClick={() => handleModelSelect(model.id)}
                  className={`w-full px-3 py-2 text-left hover:bg-surface-secondary transition-colors ${
                    model.id === modelId ? 'bg-feedback-info-bg' : ''
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-fg-default truncate">
                        {model.name}
                      </div>
                      <div className="text-xs text-fg-muted mt-0.5 truncate">{model.provider}</div>
                    </div>
                    {model.id === modelId && (
                      <div className="w-2 h-2 rounded-full bg-action-primary ml-2 flex-shrink-0" />
                    )}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
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
