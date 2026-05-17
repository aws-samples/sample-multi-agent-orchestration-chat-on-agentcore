import React from 'react';
import { cn } from '../../../lib/utils';
import type { ModalFooterProps } from './types';

export const ModalFooter: React.FC<ModalFooterProps> = ({
  children,
  className,
  align = 'right',
}) => {
  const alignClasses = {
    left: 'justify-start',
    center: 'justify-center',
    right: 'justify-end',
    between: 'justify-between',
  };

  return (
    <div
      className={cn(
        'border-t border-border px-6 py-4 flex-shrink-0 flex items-center space-x-3',
        alignClasses[align],
        className
      )}
    >
      {children}
    </div>
  );
};
