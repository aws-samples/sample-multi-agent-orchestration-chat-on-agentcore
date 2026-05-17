import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, X, AlertCircle, Sparkles, Settings, Wrench, Server } from 'lucide-react';
import { ToolSelector } from './ToolSelector';
import { MCPConfigEditor } from './MCPConfigEditor';
import { IconPicker } from './ui/IconPicker';
import { SidebarTabsLayout, type TabItem } from './ui/SidebarTabs';
import { FormField } from './ui/FormField';
import { Button } from './ui/Button';
import { FolderPathSelector } from './ui/FolderPathSelector';
import type { CreateAgentInput, Agent, Scenario } from '../types/agent';
import { streamAgentResponse, createAgentConfigGenerationPrompt } from '../api/agent';
import { useToolStore } from '../stores/toolStore';
import { parseStreamingXml, createInitialXmlState } from '../utils/xmlParser';
import { translateIfKey } from '../utils/agent-translation';
import { logger } from '../utils/logger';

interface AgentFormProps {
  agent?: Agent;
  onSubmit: (data: CreateAgentInput) => void;
  isLoading?: boolean;
}

type TabType = 'basic' | 'tools' | 'mcp';

export const AgentForm: React.FC<AgentFormProps> = ({ agent, onSubmit, isLoading = false }) => {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<TabType>('basic');
  const [formData, setFormData] = useState<CreateAgentInput>(() => {
    if (agent) {
      return {
        name: translateIfKey(agent.name, t),
        description: translateIfKey(agent.description, t),
        icon: agent.icon || 'Bot',
        systemPrompt: agent.systemPrompt,
        enabledTools: [...agent.enabledTools],
        scenarios: agent.scenarios.map((s) => ({
          title: translateIfKey(s.title, t),
          prompt: translateIfKey(s.prompt, t),
        })),
        mcpConfig: agent.mcpConfig,
        defaultStoragePath: agent.defaultStoragePath,
      };
    }
    return {
      name: '',
      description: '',
      icon: 'Bot',
      systemPrompt: '',
      enabledTools: [],
      scenarios: [],
      mcpConfig: undefined,
      defaultStoragePath: undefined,
    };
  });

  const [errors, setErrors] = useState<Record<string, string>>({});

  // AI generation related state
  const [isGenerating, setIsGenerating] = useState(false);

  const { tools } = useToolStore();

  // Validation
  const validateForm = (): boolean => {
    const newErrors: Record<string, string> = {};

    if (!formData.name.trim()) {
      newErrors.name = t('agent.validationNameRequired');
    } else if (formData.name.length > 50) {
      newErrors.name = t('agent.validationNameTooLong');
    }

    if (!formData.description.trim()) {
      newErrors.description = t('agent.validationDescriptionRequired');
    } else if (formData.description.length > 200) {
      newErrors.description = t('agent.validationDescriptionTooLong');
    }

    if (!formData.systemPrompt.trim()) {
      newErrors.systemPrompt = t('agent.validationSystemPromptRequired');
    } else if (formData.systemPrompt.length < 10) {
      newErrors.systemPrompt = t('agent.validationSystemPromptTooShort');
    }

    // Scenario validation
    formData.scenarios.forEach((scenario, index) => {
      if (!scenario.title.trim()) {
        newErrors[`scenario_title_${index}`] = t('agent.validationScenarioTitleRequired');
      }
      if (!scenario.prompt.trim()) {
        newErrors[`scenario_prompt_${index}`] = t('agent.validationScenarioPromptRequired');
      }
    });

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  // Form submission
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    if (!validateForm()) {
      return;
    }

    onSubmit(formData);
  };

  // Add scenario
  const addScenario = () => {
    setFormData((prev) => ({
      ...prev,
      scenarios: [
        ...prev.scenarios,
        {
          title: '',
          prompt: '',
        },
      ],
    }));
  };

  // Remove scenario
  const removeScenario = (index: number) => {
    setFormData((prev) => ({
      ...prev,
      scenarios: prev.scenarios.filter((_, i) => i !== index),
    }));

    // Remove corresponding errors as well
    setErrors((prev) => {
      const newErrors = { ...prev };
      delete newErrors[`scenario_title_${index}`];
      delete newErrors[`scenario_prompt_${index}`];
      return newErrors;
    });
  };

  // Update scenario
  const updateScenario = (index: number, field: keyof Scenario, value: string) => {
    setFormData((prev) => ({
      ...prev,
      scenarios: prev.scenarios.map((scenario, i) =>
        i === index ? { ...scenario, [field]: value } : scenario
      ),
    }));

    // Clear errors
    if (errors[`scenario_${field}_${index}`]) {
      setErrors((prev) => {
        const newErrors = { ...prev };
        delete newErrors[`scenario_${field}_${index}`];
        return newErrors;
      });
    }
  };

  // AI generation feature
  const handleAIGeneration = async () => {
    if (!formData.name.trim() || !formData.description.trim()) {
      return;
    }

    setIsGenerating(true);

    // Initialize XML parse state
    const initialParseState = createInitialXmlState();

    // Get available tool names
    const availableTools = tools.map((tool) => tool.name);

    // Create generation prompt
    const generationPrompt = createAgentConfigGenerationPrompt(
      formData.name,
      formData.description,
      availableTools
    );

    try {
      let currentParseState = initialParseState;
      let accumulatedXml = '';

      await streamAgentResponse(generationPrompt, undefined, {
        onTextDelta: (text: string) => {
          accumulatedXml += text;

          // Incrementally parse XML and reflect in form
          const { state: newParseState, updates } = parseStreamingXml(
            accumulatedXml,
            currentParseState
          );
          currentParseState = newParseState;

          // Update system prompt
          if (updates.systemPrompt !== undefined) {
            setFormData((prev) => ({
              ...prev,
              systemPrompt: updates.systemPrompt || '',
            }));
          }

          // Update tool selection
          if (updates.newTool) {
            setFormData((prev) => ({
              ...prev,
              enabledTools: [...new Set([...prev.enabledTools, updates.newTool!])],
            }));
          }

          // Add scenario
          if (updates.newScenario) {
            setFormData((prev) => ({
              ...prev,
              scenarios: [...prev.scenarios, updates.newScenario!],
            }));
          }
        },
        onComplete: () => {
          logger.log('AI generation completed');
          setIsGenerating(false);
        },
        onError: (error: Error) => {
          logger.error('AI generation error (onError callback):', error);
          setErrors((prev) => ({
            ...prev,
            generation: `${t('agent.validationGenerationFailed')}: ${error.message}`,
          }));
          setIsGenerating(false);
        },
      });
    } catch (error) {
      logger.error('AI generation error (caught):', error);
      setErrors((prev) => ({
        ...prev,
        generation: `${t('agent.validationGenerationFailed')}: ${error instanceof Error ? error.message : '不明なエラー'}`,
      }));
      setIsGenerating(false);
    }
  };

  // Tab configuration
  const tabs: TabItem<TabType>[] = [
    { id: 'basic', label: t('agent.basicSettings'), icon: Settings },
    { id: 'tools', label: t('agent.toolsSettings'), icon: Wrench },
    { id: 'mcp', label: t('agent.mcpSettings'), icon: Server },
  ];

  return (
    <SidebarTabsLayout tabs={tabs} activeTab={activeTab} onTabChange={setActiveTab}>
      <form id="agent-form" onSubmit={handleSubmit} className="flex-1 flex flex-col">
        {/* Panel content */}
        <div className="h-[80vh] overflow-y-auto px-6 py-6">
          {/* Basic settings panel */}
          {activeTab === 'basic' && (
            <div className="space-y-6 max-w-5xl mx-auto">
              <h2 className="text-lg font-semibold text-fg-default mb-6">
                {t('agent.basicSettings')}
              </h2>

              {/* Agent name */}
              <FormField
                label={t('agent.nameAndIcon')}
                htmlFor="name"
                description={t('agent.nameDescription')}
                error={errors.name}
              >
                <div className="flex flex-col md:flex-row md:items-center space-y-3 md:space-y-0 md:space-x-3">
                  <IconPicker
                    value={formData.icon}
                    onChange={(icon) => setFormData((prev) => ({ ...prev, icon }))}
                    disabled={isLoading || isGenerating}
                  />
                  <input
                    type="text"
                    id="name"
                    value={formData.name}
                    onChange={(e) => {
                      setFormData((prev) => ({ ...prev, name: e.target.value }));
                      if (errors.name) {
                        setErrors((prev) => ({ ...prev, name: '' }));
                      }
                    }}
                    disabled={isLoading || isGenerating}
                    placeholder={t('agent.namePlaceholder')}
                    className={`flex-1 px-4 py-3 border rounded-input bg-surface-primary text-fg-default focus:ring-2 focus:ring-border-focus focus:border-transparent disabled:bg-surface-secondary disabled:cursor-not-allowed ${
                      errors.name ? 'border-feedback-error' : 'border-border'
                    }`}
                  />
                </div>
              </FormField>

              {/* Description */}
              <FormField
                label={t('agent.descriptionLabel')}
                htmlFor="description"
                description={t('agent.descriptionDescription')}
                error={errors.description}
              >
                <textarea
                  id="description"
                  value={formData.description}
                  onChange={(e) => {
                    setFormData((prev) => ({ ...prev, description: e.target.value }));
                    if (errors.description) {
                      setErrors((prev) => ({ ...prev, description: '' }));
                    }
                  }}
                  disabled={isLoading || isGenerating}
                  placeholder={t('agent.descriptionPlaceholder2')}
                  rows={3}
                  className={`w-full px-4 py-3 border rounded-input bg-surface-primary text-fg-default focus:ring-2 focus:ring-border-focus focus:border-transparent disabled:bg-surface-secondary disabled:cursor-not-allowed resize-none ${
                    errors.description ? 'border-feedback-error' : 'border-border'
                  }`}
                />
              </FormField>

              {/* System prompt */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label htmlFor="systemPrompt" className="text-sm font-medium text-fg-secondary">
                    {t('agent.systemPromptRequired')}
                  </label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    leftIcon={Sparkles}
                    onClick={handleAIGeneration}
                    disabled={
                      isLoading ||
                      isGenerating ||
                      !formData.name.trim() ||
                      !formData.description.trim()
                    }
                  >
                    {isGenerating ? t('agent.aiGenerating') : t('agent.aiGenerate')}
                  </Button>
                </div>
                <p className="text-sm text-fg-muted mb-3">{t('agent.systemPromptDescription')}</p>
                <textarea
                  id="systemPrompt"
                  value={formData.systemPrompt}
                  onChange={(e) => {
                    setFormData((prev) => ({ ...prev, systemPrompt: e.target.value }));
                    if (errors.systemPrompt) {
                      setErrors((prev) => ({ ...prev, systemPrompt: '' }));
                    }
                  }}
                  disabled={isLoading || isGenerating}
                  placeholder={t('agent.systemPromptPlaceholder2')}
                  rows={12}
                  className={`w-full px-4 py-2 border rounded-input bg-surface-primary text-fg-default focus:ring-2 focus:ring-border-focus focus:border-transparent disabled:bg-surface-secondary disabled:cursor-not-allowed resize-y font-mono text-sm ${
                    errors.systemPrompt ? 'border-feedback-error' : 'border-border'
                  }`}
                />
                {errors.systemPrompt && (
                  <div className="flex items-center space-x-1 mt-2">
                    <AlertCircle className="w-4 h-4 text-feedback-error" />
                    <span className="text-sm text-feedback-error">{errors.systemPrompt}</span>
                  </div>
                )}
                {errors.generation && (
                  <div className="flex items-center space-x-1 mt-2">
                    <AlertCircle className="w-4 h-4 text-feedback-error" />
                    <span className="text-sm text-feedback-error">{errors.generation}</span>
                  </div>
                )}
              </div>

              {/* Scenarios */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-sm font-medium text-fg-secondary">
                    {t('agent.scenarios')}
                  </label>
                  <button
                    type="button"
                    onClick={addScenario}
                    disabled={isLoading || isGenerating}
                    className="inline-flex items-center space-x-1 text-sm text-action-primary hover:opacity-80 disabled:text-fg-disabled disabled:cursor-not-allowed"
                  >
                    <Plus className="w-4 h-4" />
                    <span>{t('agent.addScenario')}</span>
                  </button>
                </div>

                <p className="text-sm text-fg-muted mb-4">{t('agent.scenariosDescription')}</p>

                <div className="space-y-3">
                  {formData.scenarios.map((scenario, index) => (
                    <div key={index} className="flex items-start space-x-3">
                      <div className="flex-shrink-0 w-48">
                        <textarea
                          value={scenario.title}
                          onChange={(e) => updateScenario(index, 'title', e.target.value)}
                          disabled={isLoading || isGenerating}
                          placeholder={t('agent.scenarioTitlePlaceholder')}
                          rows={2}
                          className={`w-full px-3 py-2 border rounded-input bg-surface-primary text-fg-default focus:ring-2 focus:ring-border-focus focus:border-transparent disabled:bg-surface-secondary disabled:cursor-not-allowed resize-y ${
                            errors[`scenario_title_${index}`]
                              ? 'border-feedback-error'
                              : 'border-border'
                          }`}
                        />
                        {errors[`scenario_title_${index}`] && (
                          <div className="flex items-center space-x-1 mt-1">
                            <AlertCircle className="w-3 h-3 text-feedback-error" />
                            <span className="text-xs text-feedback-error">
                              {errors[`scenario_title_${index}`]}
                            </span>
                          </div>
                        )}
                      </div>

                      <div className="flex-1">
                        <textarea
                          value={scenario.prompt}
                          onChange={(e) => updateScenario(index, 'prompt', e.target.value)}
                          disabled={isLoading || isGenerating}
                          placeholder={t('agent.scenarioPromptPlaceholder')}
                          rows={2}
                          className={`w-full px-3 py-2 border rounded-input bg-surface-primary text-fg-default focus:ring-2 focus:ring-border-focus focus:border-transparent disabled:bg-surface-secondary disabled:cursor-not-allowed resize-y ${
                            errors[`scenario_prompt_${index}`]
                              ? 'border-feedback-error'
                              : 'border-border'
                          }`}
                        />
                        {errors[`scenario_prompt_${index}`] && (
                          <div className="flex items-center space-x-1 mt-1">
                            <AlertCircle className="w-3 h-3 text-feedback-error" />
                            <span className="text-xs text-feedback-error">
                              {errors[`scenario_prompt_${index}`]}
                            </span>
                          </div>
                        )}
                      </div>

                      <button
                        type="button"
                        onClick={() => removeScenario(index)}
                        disabled={isLoading || isGenerating}
                        className="flex-shrink-0 p-1 text-fg-disabled hover:text-feedback-error disabled:text-fg-disabled disabled:cursor-not-allowed transition-colors"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  ))}
                </div>

                {formData.scenarios.length === 0 && (
                  <div className="text-center py-6 text-fg-disabled text-sm bg-surface-secondary rounded-card border border-border border-dashed">
                    {t('agent.emptyScenarios')}
                  </div>
                )}
              </div>

              {/* Default Storage Path */}
              <FormField
                label={t('agent.defaultStoragePath')}
                htmlFor="defaultStoragePath"
                description={t('agent.defaultStoragePathDescription')}
              >
                <FolderPathSelector
                  value={formData.defaultStoragePath}
                  onChange={(path) =>
                    setFormData((prev) => ({ ...prev, defaultStoragePath: path }))
                  }
                  disabled={isLoading || isGenerating}
                  id="defaultStoragePath"
                />
              </FormField>
            </div>
          )}

          {/* Tools panel */}
          {activeTab === 'tools' && (
            <div className="space-y-6 max-w-5xl mx-auto">
              <h2 className="text-lg font-semibold text-fg-default mb-6">
                {t('agent.toolSelection')}
              </h2>
              <ToolSelector
                selectedTools={formData.enabledTools}
                onSelectionChange={(tools) =>
                  setFormData((prev) => ({ ...prev, enabledTools: tools }))
                }
                disabled={isLoading || isGenerating}
              />
            </div>
          )}

          {/* MCP panel */}
          {activeTab === 'mcp' && (
            <div className="space-y-6 max-w-5xl mx-auto">
              <h2 className="text-lg font-semibold text-fg-default mb-6">
                {t('agent.mcpServerSettings')}
              </h2>
              <MCPConfigEditor
                config={formData.mcpConfig}
                onChange={(config) => setFormData((prev) => ({ ...prev, mcpConfig: config }))}
                disabled={isLoading || isGenerating}
              />
            </div>
          )}
        </div>
      </form>
    </SidebarTabsLayout>
  );
};
