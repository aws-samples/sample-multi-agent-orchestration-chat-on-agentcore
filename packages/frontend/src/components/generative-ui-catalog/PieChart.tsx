import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  PieChart as RechartsPieChart,
  Pie,
  Cell,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import type { BaseComponentProps } from '@json-render/react';

interface PieChartDataItem {
  name: string;
  value: number;
  color?: string;
}

interface PieChartProps {
  title?: string;
  data: PieChartDataItem[];
  height?: number;
  /** Show percentage labels on slices */
  showLabels?: boolean;
  /** Inner radius for donut chart (0 = full pie) */
  innerRadius?: number;
}

const DEFAULT_COLORS = [
  '#3b82f6',
  '#ef4444',
  '#10b981',
  '#f59e0b',
  '#8b5cf6',
  '#ec4899',
  '#06b6d4',
  '#f97316',
];

const RADIAN = Math.PI / 180;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const renderCustomLabel = (labelProps: any) => {
  const { cx, cy, midAngle, innerRadius, outerRadius, percent } = labelProps;
  if (!percent || percent < 0.05) return null; // Don't render label for very small slices
  const radius = (innerRadius ?? 0) + ((outerRadius ?? 80) - (innerRadius ?? 0)) * 0.5;
  const x = (cx ?? 0) + radius * Math.cos(-midAngle * RADIAN);
  const y = (cy ?? 0) + radius * Math.sin(-midAngle * RADIAN);

  return (
    <text
      x={x}
      y={y}
      fill="white"
      textAnchor="middle"
      dominantBaseline="central"
      fontSize={12}
      fontWeight={600}
    >
      {`${(percent * 100).toFixed(0)}%`}
    </text>
  );
};

const PieChartComponent = ({ props }: BaseComponentProps<PieChartProps>): React.ReactNode => {
  const { t } = useTranslation();
  const { title, data, height = 300, showLabels = true, innerRadius = 0 } = props;

  if (!data || data.length === 0) {
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
        <RechartsPieChart>
          <Pie
            data={data}
            cx="50%"
            cy="50%"
            innerRadius={innerRadius}
            outerRadius="80%"
            paddingAngle={data.length > 1 ? 2 : 0}
            dataKey="value"
            nameKey="name"
            label={showLabels ? renderCustomLabel : false}
            labelLine={false}
          >
            {data.map((entry, i) => (
              <Cell
                key={`cell-${i}`}
                fill={entry.color || DEFAULT_COLORS[i % DEFAULT_COLORS.length]}
              />
            ))}
          </Pie>
          <Tooltip
            contentStyle={{
              backgroundColor: 'var(--color-surface-primary, #fff)',
              border: '1px solid var(--color-border, #e5e7eb)',
              borderRadius: '8px',
              fontSize: '12px',
            }}
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            formatter={(value: any) =>
              typeof value === 'number' ? value.toLocaleString() : String(value)
            }
          />
          <Legend
            wrapperStyle={{ fontSize: '12px' }}
            formatter={(value: string) => <span className="text-fg-secondary">{value}</span>}
          />
        </RechartsPieChart>
      </ResponsiveContainer>
    </div>
  );
};

export default PieChartComponent;
