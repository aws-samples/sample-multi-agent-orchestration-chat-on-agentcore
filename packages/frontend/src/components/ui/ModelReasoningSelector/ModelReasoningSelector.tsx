/**
 * ModelReasoningSelector Component
 *
 * One combined dropdown for picking the Bedrock model AND its extended-thinking
 * depth (reasoning effort), replacing the former separate ModelSelector +
 * ReasoningDepthSelector. The trigger button shows a compact model name plus a
 * small depth badge (e.g. "Opus 4.8 高"); the panel shows the model list and,
 * for reasoning-capable models, a "思考の深さ" row that opens a depth submenu.
 *
 * Two modes (controlled iff `onModelChange` is supplied):
 *   - **Store-driven** (propless): reads/writes the global useSettingsStore
 *     (selectedModelId + per-model depth). Used by the chat input.
 *   - **Controlled** (props): the caller owns modelId/reasoningEffort. Used by
 *     the trigger form, whose model is per-form state.
 *
 * NOTE: in chat the panel opens upward (`position="top"`); do NOT wrap this in
 * an `overflow-*` ancestor or the upward panel gets clipped (overflow-x:auto
 * also clips overflow-y). The trigger form passes `position="bottom"`.
 */

import React, { useState, useRef, useEffect, useId } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronRight, ChevronLeft, Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { isReasoningCapable, type ReasoningDepth } from '@moca/core';
import { AVAILABLE_MODELS, getModelById } from '../../../config/models';
import { useSettingsStore } from '../../../stores/settingsStore';
import { Badge } from '../Badge';
import type { ModelUsageIndicator } from '../../../utils/usageFormat';
import {
  shortModelName,
  availableDepthsFor,
  reasoningDepthLabelKey,
  showReasoningBadge,
} from './helpers';

export interface ModelReasoningSelectorProps {
  /** Controlled mode: model id owned by the caller (trigger form). */
  modelId?: string;
  /** Controlled mode: current reasoning depth. */
  reasoningEffort?: ReasoningDepth;
  /** Controlled mode: presence of this callback switches to controlled mode. */
  onModelChange?: (modelId: string) => void;
  /** Controlled mode: depth change callback. */
  onReasoningEffortChange?: (depth: ReasoningDepth) => void;
  /** Dropdown direction: 'top' opens upward (chat, default), 'bottom' downward (modal). */
  position?: 'top' | 'bottom';
  disabled?: boolean;
  /**
   * Monthly token-limit state per model id, supplied by a store-connected
   * parent. Only `warning` / `exceeded` models get a badge; `exceeded` ones
   * are not selectable and expose `description` via aria-describedby.
   */
  usageFor?: (modelId: string) => ModelUsageIndicator | undefined;
  /** Route of the usage page, linked from the menu footer while any badge shows. */
  usageHref?: string;
}

export type { ModelUsageIndicator };

export const ModelReasoningSelector: React.FC<ModelReasoningSelectorProps> = (props) => {
  const { t } = useTranslation();
  const { position = 'top', disabled = false, usageFor, usageHref } = props;
  const descriptionIdPrefix = useId();

  // Controlled iff an onModelChange handler was supplied.
  const controlled = props.onModelChange !== undefined;

  // Subscribe to store state ONLY in store-driven mode. In controlled mode the
  // selectors return constants, so global model/depth changes (e.g. the chat
  // input) never re-render a controlled instance (e.g. the trigger form modal).
  const storeModelId = useSettingsStore((s) => (controlled ? '' : s.selectedModelId));
  const storeDepth = useSettingsStore((s) =>
    controlled ? 'off' : (s.reasoningDepthByModel[s.selectedModelId] ?? 'off')
  );

  const [isOpen, setIsOpen] = useState(false);
  const [view, setView] = useState<'models' | 'depth'>('models');
  const dropdownRef = useRef<HTMLDivElement>(null);

  const effectiveModelId = controlled ? (props.modelId ?? '') : storeModelId;
  // Controlled mode keeps an unset depth as undefined: it runs with the model
  // default, which differs from `off` on models with an offThinkingMode.
  const currentDepth: ReasoningDepth | undefined = controlled ? props.reasoningEffort : storeDepth;

  // Close on outside click / Escape; reset to the model view whenever closed.
  useEffect(() => {
    if (!isOpen) return;
    const onMouseDown = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false);
        setView('models');
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsOpen(false);
        setView('models');
      }
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [isOpen]);

  const capable = isReasoningCapable(effectiveModelId);
  const depths = availableDepthsFor(effectiveModelId);
  const selectedModel = getModelById(effectiveModelId);
  const triggerLabel = selectedModel ? shortModelName(selectedModel.name) : effectiveModelId;

  const open = () => {
    setView('models');
    setIsOpen((v) => !v);
  };
  const close = () => {
    setIsOpen(false);
    setView('models');
  };

  const selectModel = (id: string) => {
    if (controlled) {
      props.onModelChange!(id);
    } else {
      // Read setters via getState() so we don't subscribe to (and re-render on)
      // unrelated store changes — see the controlled-aware selectors above.
      useSettingsStore.getState().setSelectedModelId(id);
    }
    close();
  };

  const selectDepth = (depth: ReasoningDepth) => {
    if (controlled) {
      props.onReasoningEffortChange?.(depth);
    } else {
      useSettingsStore.getState().setReasoningDepthFor(effectiveModelId, depth);
    }
    close();
  };

  const hasUsageBadge = AVAILABLE_MODELS.some((m) => {
    const status = usageFor?.(m.id)?.status;
    return status === 'warning' || status === 'exceeded';
  });

  const panelPosition = position === 'bottom' ? 'top-full mt-1' : 'bottom-full mb-2';

  return (
    <div ref={dropdownRef} className="relative inline-block">
      {/* Trigger button: compact model name + model-aware depth badge. */}
      <button
        type="button"
        onClick={() => !disabled && open()}
        disabled={disabled}
        className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-fg-secondary hover:text-fg-default hover:bg-surface-secondary rounded-lg transition-colors whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
        aria-haspopup="menu"
        aria-expanded={isOpen}
      >
        <span className="font-medium">{triggerLabel}</span>
        {showReasoningBadge(effectiveModelId, currentDepth) && (
          <span className="px-1.5 py-0.5 rounded-sm text-xs bg-surface-secondary text-fg-secondary">
            {t(reasoningDepthLabelKey(effectiveModelId, currentDepth))}
          </span>
        )}
        <ChevronDown
          className={`w-4 h-4 text-fg-disabled transition-transform ${isOpen ? 'rotate-180' : ''}`}
        />
      </button>

      {isOpen && (
        <div
          className={`absolute ${panelPosition} left-0 w-64 bg-surface-primary rounded-xl shadow-lg border border-border py-2 z-50`}
          role="menu"
        >
          {view === 'models' ? (
            <>
              {/* Model list (name only; checkmark on the active one). */}
              <div className="max-h-64 overflow-y-auto">
                {AVAILABLE_MODELS.map((model) => {
                  const usage = usageFor?.(model.id);
                  const exceeded = usage?.status === 'exceeded';
                  const selected = model.id === effectiveModelId;
                  const descriptionId = `${descriptionIdPrefix}-${model.id}`;
                  return (
                    <button
                      key={model.id}
                      type="button"
                      // aria-disabled (not disabled) keeps the row focusable so
                      // keyboard and screen-reader users still hear why.
                      aria-disabled={exceeded || undefined}
                      aria-describedby={exceeded && usage?.description ? descriptionId : undefined}
                      onClick={() => !exceeded && selectModel(model.id)}
                      className={`group w-full px-3 py-2 text-left text-sm transition-colors ${
                        exceeded ? 'cursor-not-allowed' : 'hover:bg-surface-secondary'
                      } ${selected ? 'bg-feedback-info-bg' : ''}`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span
                          className={`font-medium truncate ${
                            exceeded ? 'text-fg-disabled' : 'text-fg-default'
                          }`}
                        >
                          {model.name}
                        </span>
                        <span className="flex items-center gap-1.5 shrink-0">
                          {usage?.status === 'warning' && (
                            <Badge variant="warning" size="sm">
                              {t('common.usageBadge.warning')}
                            </Badge>
                          )}
                          {exceeded && (
                            <Badge variant="danger" size="sm">
                              {t('common.usageBadge.exceeded')}
                            </Badge>
                          )}
                          {selected && <Check className="w-4 h-4 text-fg-link" />}
                        </span>
                      </div>
                      {exceeded && usage?.description && (
                        // Shown on hover / focus; always the row's accessible description.
                        <span
                          id={descriptionId}
                          className="hidden group-hover:block group-focus-visible:block mt-1 text-xs text-fg-muted"
                        >
                          {usage.description}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>

              {/* Reasoning-depth entry row — only for capable models. */}
              {capable && (
                <>
                  <div className="my-1 border-t border-border" />
                  <button
                    type="button"
                    onClick={() => setView('depth')}
                    className="w-full px-3 py-2 text-left text-sm hover:bg-surface-secondary transition-colors flex items-center justify-between gap-2"
                  >
                    <span className="text-fg-default">{t('common.reasoningDepth')}</span>
                    <span className="flex items-center gap-1 text-fg-muted">
                      {t(reasoningDepthLabelKey(effectiveModelId, currentDepth))}
                      <ChevronRight className="w-4 h-4 text-fg-disabled" />
                    </span>
                  </button>
                </>
              )}

              {usageHref && hasUsageBadge && (
                <>
                  <div className="my-1 border-t border-border" />
                  <Link
                    to={usageHref}
                    onClick={close}
                    className="block px-3 py-2 text-xs text-fg-link hover:underline"
                  >
                    {t('common.usageBadge.viewUsage')}
                  </Link>
                </>
              )}
            </>
          ) : (
            <>
              {/* Depth submenu with a back affordance. */}
              <button
                type="button"
                onClick={() => setView('models')}
                className="w-full px-3 py-2 text-left text-sm hover:bg-surface-secondary transition-colors flex items-center gap-1 text-fg-secondary"
              >
                <ChevronLeft className="w-4 h-4 text-fg-disabled" />
                <span className="font-medium">{t('common.reasoningDepth')}</span>
              </button>
              <div className="my-1 border-t border-border" />
              {depths.map((depth) => (
                <button
                  key={depth}
                  type="button"
                  onClick={() => selectDepth(depth)}
                  className={`w-full px-3 py-2 text-left text-sm hover:bg-surface-secondary transition-colors ${
                    depth === currentDepth ? 'bg-feedback-info-bg' : ''
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-fg-default">
                      {t(reasoningDepthLabelKey(effectiveModelId, depth))}
                    </span>
                    {depth === currentDepth && <Check className="w-4 h-4 text-fg-link shrink-0" />}
                  </div>
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
};
