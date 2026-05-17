import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  BarChart as RechartsBarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import type { BaseComponentProps } from '@json-render/react';

interface BarChartDataItem {
  [key: string]: unknown;
}

interface BarDef {
  key: string;
  color?: string;
  name?: string;
}

interface BarChartProps {
  title?: string;
  data: BarChartDataItem[];
  xKey: string;
  bars?: BarDef[];
  /** Shorthand: single bar key (used when bars is not provided) */
  yKey?: string;
  /** Shorthand: single bar color */
  color?: string;
  height?: number;
  stacked?: boolean;
}

const DEFAULT_COLORS = ['#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899'];

const BarChartComponent = ({ props }: BaseComponentProps<BarChartProps>): React.ReactNode => {
  const { t } = useTranslation();
  const { title, data, xKey, bars, yKey, color, height = 300, stacked = false } = props;

  // Determine bar definitions: explicit bars array or single yKey shorthand
  const barDefs: BarDef[] =
    bars && bars.length > 0 ? bars : yKey ? [{ key: yKey, color: color || DEFAULT_COLORS[0] }] : [];

  if (barDefs.length === 0 || !data || data.length === 0) {
    return (
      <div className="bg-surface-primary border border-border rounded-lg p-4">
        {title && <div className="text-sm font-medium text-fg-default mb-2">{title}</div>}
        <div className="text-sm text-fg-muted text-center py-8">
          {t('generativeUi.noChartData')}
        </div>
      </div>
    );
  }

  return (
    <div className="bg-surface-primary border border-border rounded-lg p-4">
      {title && <div className="text-sm font-medium text-fg-default mb-3">{title}</div>}
      <ResponsiveContainer width="100%" height={height}>
        <RechartsBarChart data={data} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border, #e5e7eb)" />
          <XAxis
            dataKey={xKey}
            tick={{ fontSize: 12, fill: 'var(--color-fg-muted, #6b7280)' }}
            axisLine={{ stroke: 'var(--color-border, #e5e7eb)' }}
          />
          <YAxis
            tick={{ fontSize: 12, fill: 'var(--color-fg-muted, #6b7280)' }}
            axisLine={{ stroke: 'var(--color-border, #e5e7eb)' }}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: 'var(--color-surface-primary, #fff)',
              border: '1px solid var(--color-border, #e5e7eb)',
              borderRadius: '8px',
              fontSize: '12px',
            }}
          />
          {barDefs.length > 1 && <Legend wrapperStyle={{ fontSize: '12px' }} />}
          {barDefs.map((bar, i) => (
            <Bar
              key={bar.key}
              dataKey={bar.key}
              name={bar.name || bar.key}
              fill={bar.color || DEFAULT_COLORS[i % DEFAULT_COLORS.length]}
              radius={[4, 4, 0, 0]}
              stackId={stacked ? 'stack' : undefined}
            />
          ))}
        </RechartsBarChart>
      </ResponsiveContainer>
    </div>
  );
};

export default BarChartComponent;
