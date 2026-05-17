import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertCircle,
  CheckCircle,
  Loader2,
  ChevronDown,
  XCircle,
  ChevronRight,
} from 'lucide-react';
import type { MCPConfig } from '../types/agent';
import { fetchLocalMCPTools, type MCPServerError } from '../api/tools';

interface MCPConfigEditorProps {
  config?: MCPConfig;
  onChange: (config: MCPConfig | undefined) => void;
  disabled?: boolean;
}

interface MCPToolPreview {
  serverName: string;
  name: string;
  description?: string;
}

const SAMPLE_CONFIGS = (t: (key: string) => string) => ({
  deepwiki: {
    label: t('tool.mcp.samples.deepwiki'),
    config: {
      mcpServers: {
        deepwiki: {
          transport: 'http' as const,
          url: 'https://mcp.deepwiki.com/mcp',
        },
      },
    },
  },
  awsKnowledge: {
    label: t('tool.mcp.samples.awsKnowledge'),
    config: {
      mcpServers: {
        'aws-knowledge-mcp-server': {
          transport: 'http' as const,
          url: 'https://knowledge-mcp.global.api.aws',
        },
      },
    },
  },
});

export const MCPConfigEditor: React.FC<MCPConfigEditorProps> = ({
  config,
  onChange,
  disabled = false,
}) => {
  const { t } = useTranslation();
  const [jsonText, setJsonText] = useState<string>(() => {
    if (config) {
      return JSON.stringify(config, null, 2);
    }
    return '';
  });

  const [validationError, setValidationError] = useState<string | null>(null);
  const [isFetchingTools, setIsFetchingTools] = useState(false);
  const [toolsPreview, setToolsPreview] = useState<MCPToolPreview[]>([]);
  const [serverErrors, setServerErrors] = useState<MCPServerError[]>([]);
  const [showSampleDropdown, setShowSampleDropdown] = useState(false);
  const [messageIndex, setMessageIndex] = useState(0);
  const [expandedErrors, setExpandedErrors] = useState<Set<string>>(new Set());

  // useEffect for rotation message
  useEffect(() => {
    if (!isFetchingTools) return;

    const messages = t('tool.mcp.fetchingMessages', { returnObjects: true }) as string[];
    const interval = setInterval(() => {
      setMessageIndex((prev) => (prev + 1) % messages.length);
    }, 5000);

    return () => clearInterval(interval);
  }, [isFetchingTools, t]);

  // Change JSON text
  const handleTextChange = (text: string) => {
    setJsonText(text);
    setValidationError(null);

    // Return undefined if empty
    if (!text.trim()) {
      onChange(undefined);
      setToolsPreview([]);
      return;
    }

    // Try parsing JSON (no real-time validation)
    try {
      const parsed = JSON.parse(text);
      onChange(parsed);
    } catch {
      // Parse errors checked on save, ignore here
    }
  };

  // Preview tool
  const handleFetchTools = async () => {
    try {
      if (!jsonText.trim()) {
        setValidationError(t('tool.mcp.emptyConfig'));
        return;
      }

      const parsed = JSON.parse(jsonText);
      setMessageIndex(0);
      setIsFetchingTools(true);
      setValidationError(null);

      const result = await fetchLocalMCPTools(parsed);
      setToolsPreview(result.tools);
      setServerErrors(result.errors);
    } catch (error) {
      setValidationError(
        error instanceof Error
          ? `${t('tool.mcp.fetchError')}: ${error.message}`
          : t('tool.mcp.fetchFailed')
      );
      setToolsPreview([]);
      setServerErrors([]);
    } finally {
      setIsFetchingTools(false);
    }
  };

  // Insert sample
  const handleInsertSample = (sampleKey: keyof ReturnType<typeof SAMPLE_CONFIGS>) => {
    const samples = SAMPLE_CONFIGS(t);
    const sample = samples[sampleKey];
    const sampleText = JSON.stringify(sample.config, null, 2);
    setJsonText(sampleText);
    onChange(sample.config);
    setShowSampleDropdown(false);
    setValidationError(null);
    setToolsPreview([]);
    setServerErrors([]);
    setExpandedErrors(new Set());
  };

  // Expand/collapse error details
  const toggleErrorDetails = (serverName: string) => {
    setExpandedErrors((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(serverName)) {
        newSet.delete(serverName);
      } else {
        newSet.add(serverName);
      }
      return newSet;
    });
  };

  // Group by server name
  const groupedTools = toolsPreview.reduce(
    (acc, tool) => {
      if (!acc[tool.serverName]) {
        acc[tool.serverName] = [];
      }
      acc[tool.serverName].push(tool);
      return acc;
    },
    {} as Record<string, MCPToolPreview[]>
  );

  return (
    <div className="space-y-4">
      {/* Description */}
      <div className="text-sm text-fg-secondary">
        <p>{t('tool.mcp.description')}</p>
      </div>

      {/* JSON editor */}
      <div>
        <label className="block text-sm font-medium text-fg-secondary mb-2">
          {t('tool.mcp.configLabel')}
        </label>
        <textarea
          value={jsonText}
          onChange={(e) => handleTextChange(e.target.value)}
          disabled={disabled}
          placeholder={`{\n  "mcpServers": {\n    "my-server": {\n      "transport": "http",\n      "url": "https://your-mcp-server.example.com/mcp"\n    }\n  }\n}`}
          rows={12}
          className="w-full px-3 py-2 border border-border-strong rounded-lg bg-surface-primary text-fg-default focus:ring-2 focus:ring-border-focus focus:border-transparent disabled:bg-surface-secondary disabled:cursor-not-allowed resize-none font-mono text-sm"
        />
      </div>

      {/* Action buttons */}
      <div className="flex items-center space-x-3">
        {/* Sample insertion dropdown */}
        <div className="relative">
          <button
            type="button"
            onClick={() => setShowSampleDropdown(!showSampleDropdown)}
            disabled={disabled}
            className="inline-flex items-center space-x-2 px-3 py-2 text-sm text-fg-secondary bg-surface-primary border border-border-strong rounded-lg hover:bg-surface-secondary disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <span>{t('tool.mcp.insertSample')}</span>
            <ChevronDown className="w-4 h-4" />
          </button>

          {showSampleDropdown && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setShowSampleDropdown(false)} />
              <div className="absolute left-0 top-full mt-1 w-56 bg-surface-primary rounded-lg shadow-lg border border-border py-1 z-20">
                {Object.entries(SAMPLE_CONFIGS(t)).map(([key, sample]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() =>
                      handleInsertSample(key as keyof ReturnType<typeof SAMPLE_CONFIGS>)
                    }
                    className="w-full px-3 py-2 text-left text-sm text-fg-secondary hover:bg-surface-secondary transition-colors"
                  >
                    {sample.label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        <button
          type="button"
          onClick={handleFetchTools}
          disabled={disabled || isFetchingTools || !jsonText.trim()}
          className="inline-flex items-center space-x-2 px-3 py-2 text-sm text-white bg-action-primary rounded-lg hover:bg-action-primary-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {isFetchingTools ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              <span>
                {
                  (t('tool.mcp.fetchingMessages', { returnObjects: true }) as string[])[
                    messageIndex
                  ]
                }
              </span>
            </>
          ) : (
            <span>{t('tool.mcp.previewTools')}</span>
          )}
        </button>
      </div>

      {/* Validation error */}
      {validationError && (
        <div className="flex items-start space-x-2 p-3 bg-feedback-error-bg border border-feedback-error-border rounded-lg">
          <AlertCircle className="w-5 h-5 text-feedback-error flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="text-sm text-feedback-error">{validationError}</p>
          </div>
        </div>
      )}

      {/* Tool preview and errors */}
      {(toolsPreview.length > 0 || serverErrors.length > 0) && (
        <div className="space-y-3">
          <h3 className="text-sm font-medium text-fg-secondary">
            {t('tool.mcp.connectionResults')}
          </h3>

          {/* Successfully connected servers */}
          {toolsPreview.length > 0 && (
            <div className="p-4 bg-feedback-success-bg border border-feedback-success-border rounded-lg space-y-4">
              {Object.entries(groupedTools).map(([serverName, tools]) => (
                <div key={serverName}>
                  <h4 className="text-sm font-medium text-green-900 mb-2 flex items-center space-x-2">
                    <CheckCircle className="w-4 h-4 text-green-600" />
                    <span>
                      {serverName} ({t('tool.mcp.toolCount', { count: tools.length })})
                    </span>
                  </h4>
                  <div className="space-y-2 ml-6">
                    {tools.map((tool) => (
                      <div
                        key={`${tool.serverName}::${tool.name}`}
                        className="flex items-start space-x-2 text-sm"
                      >
                        <div>
                          <span className="font-mono text-fg-default">{tool.name}</span>
                          {tool.description && (
                            <span className="text-fg-secondary"> - {tool.description}</span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Failed to connect servers */}
          {serverErrors.length > 0 && (
            <div className="p-4 bg-feedback-error-bg border border-feedback-error-border rounded-lg space-y-3">
              <h4 className="text-sm font-medium text-feedback-error flex items-center space-x-2">
                <XCircle className="w-4 h-4 text-feedback-error" />
                <span>{t('tool.mcp.connectionErrors')}</span>
              </h4>
              <div className="space-y-3 ml-6">
                {serverErrors.map((error, index) => {
                  const isExpanded = expandedErrors.has(error.serverName);
                  return (
                    <div key={`${error.serverName}-${index}`} className="text-sm">
                      <div className="font-medium text-feedback-error">{error.serverName}</div>
                      <div className="text-feedback-error mt-1 text-xs">{error.message}</div>

                      {/* Display detailed information */}
                      {error.details && (
                        <div className="mt-2">
                          <button
                            type="button"
                            onClick={() => toggleErrorDetails(error.serverName)}
                            className="inline-flex items-center space-x-1 text-xs text-feedback-error hover:text-feedback-error transition-colors"
                          >
                            {isExpanded ? (
                              <ChevronDown className="w-3 h-3" />
                            ) : (
                              <ChevronRight className="w-3 h-3" />
                            )}
                            <span>
                              {isExpanded ? t('tool.mcp.hideDetails') : t('tool.mcp.showDetails')}
                            </span>
                          </button>

                          {isExpanded && (
                            <div className="mt-2 p-3 bg-red-100 rounded border border-feedback-error-border overflow-x-auto">
                              <pre className="text-xs font-mono text-feedback-error whitespace-pre-wrap break-all">
                                {error.details}
                              </pre>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
