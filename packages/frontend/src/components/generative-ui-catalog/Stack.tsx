import type { BaseComponentProps } from '@json-render/react';

interface StackProps {
  gap?: number;
}

const Stack = ({ props, children }: BaseComponentProps<StackProps>): React.ReactNode => (
  <div className="flex flex-col" style={{ gap: `${Math.min(props.gap ?? 4, 8) * 2}px` }}>
    {children}
  </div>
);

export default Stack;
