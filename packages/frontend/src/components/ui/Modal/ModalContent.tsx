import React from 'react';
import { cn } from '../../../lib/utils';
import type { ModalContentProps } from './types';

export const ModalContent: React.FC<ModalContentProps> = ({
  children,
  className,
  noPadding = false,
}) => {
  return (
    <div className={cn('flex-1 overflow-y-auto bg-surface-primary', className)}>
      <div className={cn(!noPadding && 'p-6')}>{children}</div>
    </div>
  );
};
