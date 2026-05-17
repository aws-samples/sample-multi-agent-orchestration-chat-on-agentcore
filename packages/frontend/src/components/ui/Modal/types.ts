import type { LucideIcon } from 'lucide-react';

export interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  size?: 'sm' | 'md' | 'lg' | 'xl' | 'full';
  closeOnOverlayClick?: boolean;
  closeOnEscape?: boolean;
  className?: string;
  children: React.ReactNode;
}

export interface ModalHeaderProps {
  children: React.ReactNode;
  className?: string;
}

export interface ModalContentProps {
  children: React.ReactNode;
  className?: string;
  noPadding?: boolean;
}

export interface ModalFooterProps {
  children: React.ReactNode;
  className?: string;
  align?: 'left' | 'center' | 'right' | 'between';
}

export interface ModalIconProps {
  icon: LucideIcon;
  className?: string;
}

export interface ModalTitleProps {
  children: React.ReactNode;
  className?: string;
}

export interface ModalCloseButtonProps {
  onClose?: () => void;
  className?: string;
}

export interface ConfirmModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  variant?: 'default' | 'danger';
}

export interface ModalContextType {
  onClose: () => void;
}
