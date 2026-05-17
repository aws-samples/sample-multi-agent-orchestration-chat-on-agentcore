import React from 'react';
import { X } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { useModalContext } from './Modal';
import type {
  ModalHeaderProps,
  ModalIconProps,
  ModalTitleProps,
  ModalCloseButtonProps,
} from './types';

export const ModalHeader: React.FC<ModalHeaderProps> = ({ children, className }) => {
  return (
    <div className={cn('border-b border-border px-6 py-4 flex-shrink-0', className)}>
      <div className="flex items-center justify-between">{children}</div>
    </div>
  );
};

export const ModalIcon: React.FC<ModalIconProps> = ({ icon: Icon, className }) => {
  return <Icon className={cn('w-6 h-6 text-action-primary', className)} />;
};

export const ModalTitle: React.FC<ModalTitleProps> = ({ children, className }) => {
  return (
    <h1 className={cn('md:text-2xl sm:text-xl font-bold text-fg-default', className)}>
      {children}
    </h1>
  );
};

export const ModalCloseButton: React.FC<ModalCloseButtonProps> = ({ onClose, className }) => {
  const { onClose: contextOnClose } = useModalContext();

  return (
    <button
      onClick={onClose || contextOnClose}
      className={cn(
        'p-2 text-fg-disabled hover:text-fg-secondary rounded-btn hover:bg-surface-secondary transition-colors',
        className
      )}
    >
      <X className="w-6 h-6" />
    </button>
  );
};
