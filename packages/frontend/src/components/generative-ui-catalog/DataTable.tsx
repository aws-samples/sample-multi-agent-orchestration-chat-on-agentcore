import React from 'react';
import { useTranslation } from 'react-i18next';
import type { BaseComponentProps } from '@json-render/react';

interface DataTableProps {
  columns: string[];
  rows: string[][];
  caption?: string;
}

const DataTable = ({ props }: BaseComponentProps<DataTableProps>): React.ReactNode => {
  const { t } = useTranslation();
  const { columns, rows, caption } = props;

  return (
    <div className="w-full overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-sm text-left">
        {caption && (
          <caption className="px-3 py-2 text-xs text-fg-muted text-left">{caption}</caption>
        )}
        <thead className="bg-surface-secondary border-b border-border">
          <tr>
            {columns.map((col, i) => (
              <th
                key={i}
                className="px-4 py-2.5 font-semibold text-fg-default text-xs uppercase tracking-wide whitespace-nowrap"
              >
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="bg-surface-primary divide-y divide-border">
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="px-4 py-6 text-center text-sm text-fg-muted">
                {t('generativeUi.noData')}
              </td>
            </tr>
          ) : (
            rows.map((row, rowIdx) => (
              <tr key={rowIdx} className="hover:bg-surface-secondary transition-colors">
                {row.map((cell, cellIdx) => (
                  <td key={cellIdx} className="px-4 py-2.5 text-fg-secondary">
                    {cell}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
};

export default DataTable;
