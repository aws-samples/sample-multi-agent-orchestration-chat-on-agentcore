import React from 'react';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';
import type { BaseComponentProps } from '@json-render/react';

interface MetricCardProps {
  title: string;
  value: string;
  description?: string;
  change?: string;
  changeType?: 'positive' | 'negative' | 'neutral';
}

const changeTypeConfig: Record<string, { className: string; Icon: React.FC<{ size?: number }> }> = {
  positive: { className: 'text-feedback-success', Icon: TrendingUp },
  negative: { className: 'text-feedback-error', Icon: TrendingDown },
  neutral: { className: 'text-fg-muted', Icon: Minus },
};

const MetricCard = ({ props, on }: BaseComponentProps<MetricCardProps>): React.ReactNode => {
  const { title, value, description, change, changeType = 'neutral' } = props;
  const config = changeTypeConfig[changeType] ?? changeTypeConfig.neutral;
  const { className: changeClass, Icon } = config;
  const press = on('press');
  const isClickable = press.bound;

  return (
    <div
      className={`bg-surface-primary border border-border rounded-lg p-4 flex flex-col gap-1.5${isClickable ? ' cursor-pointer hover:bg-surface-secondary active:bg-surface-tertiary transition-colors' : ''}`}
      onClick={isClickable ? () => press.emit() : undefined}
      role={isClickable ? 'button' : undefined}
      tabIndex={isClickable ? 0 : undefined}
      onKeyDown={
        isClickable
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                press.emit();
              }
            }
          : undefined
      }
    >
      <span className="text-xs font-medium text-fg-muted uppercase tracking-wide">{title}</span>
      <span className="text-2xl font-bold text-fg-default leading-tight">{value}</span>
      {change && (
        <span className={`text-sm font-medium inline-flex items-center gap-1 ${changeClass}`}>
          <Icon size={14} />
          {change}
        </span>
      )}
      {description && <span className="text-xs text-fg-muted mt-0.5">{description}</span>}
    </div>
  );
};

export default MetricCard;
