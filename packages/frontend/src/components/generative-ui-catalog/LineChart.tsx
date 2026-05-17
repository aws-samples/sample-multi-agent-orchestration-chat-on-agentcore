import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  LineChart as RechartsLineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import type { BaseComponentProps } from '@json-render/react';

interface LineChartDataItem {
  [key: string]: unknown;
}

interface LineDef {
  key: string;
  color?: string;
  name?: string;
  dashed?: boolean;
}

interface LineChartProps {
  title?: string;
  data: LineChartDataItem[];
  xKey: string;
  lines?: LineDef[];
  /** Shorthand: single line key */
  yKey?: string;
  /** Shorthand: single line color */
  color?: string;
  height?: number;
}

const DEFAULT_COLORS = ['#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899'];

const LineChartComponent = ({ props }: BaseComponentProps<LineChartProps>): React.ReactNode => {
  const { t } = useTranslation();
  const { title, data, xKey, lines, yKey, color, height = 300 } = props;

  // Determine line definitions
  const lineDefs: LineDef[] =
    lines && lines.length > 0
      ? lines
      : yKey
        ? [{ key: yKey, color: color || DEFAULT_COLORS[0] }]
        : [];

  if (lineDefs.length === 0 || !data || data.length === 0) {
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
        <RechartsLineChart data={data} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
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
          {lineDefs.length > 1 && <Legend wrapperStyle={{ fontSize: '12px' }} />}
          {lineDefs.map((line, i) => (
            <Line
              key={line.key}
              type="monotone"
              dataKey={line.key}
              name={line.name || line.key}
              stroke={line.color || DEFAULT_COLORS[i % DEFAULT_COLORS.length]}
              strokeWidth={2}
              strokeDasharray={line.dashed ? '5 5' : undefined}
              dot={{ r: 4, fill: line.color || DEFAULT_COLORS[i % DEFAULT_COLORS.length] }}
              activeDot={{ r: 6 }}
            />
          ))}
        </RechartsLineChart>
      </ResponsiveContainer>
    </div>
  );
};

export default LineChartComponent;
