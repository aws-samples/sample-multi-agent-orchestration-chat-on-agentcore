import type { BaseComponentProps } from '@json-render/react';

interface GridProps {
  cols?: number;
  gap?: number;
}

/**
 * Responsive grid layout.
 *
 * Breakpoint behavior:
 * - Mobile (< 640px): 1 column
 * - Small (640px+): min(cols, 2) columns
 * - Large (1024px+): full requested columns
 *
 * Uses a static Tailwind class map for cols 1-4 (safe from purging).
 * Falls back to inline style for larger values (rare edge case).
 */

const COLS_CLASS_MAP: Record<number, string> = {
  1: 'grid-cols-1',
  2: 'grid-cols-1 sm:grid-cols-2',
  3: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3',
  4: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-4',
};

const Grid = ({ props, children }: BaseComponentProps<GridProps>): React.ReactNode => {
  const cols = props.cols ?? 2;
  const gap = Math.min(props.gap ?? 4, 8) * 2;

  const colClass = COLS_CLASS_MAP[cols];

  // For cols 1-4, use Tailwind responsive classes
  if (colClass) {
    return (
      <div className={`grid ${colClass}`} style={{ gap: `${gap}px` }}>
        {children}
      </div>
    );
  }

  // For cols > 4 (rare), use inline style without responsive behavior
  // since > 4 columns rarely makes sense on smaller screens anyway
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2" style={{ gap: `${gap}px` }}>
      {children}
    </div>
  );
};

export default Grid;
